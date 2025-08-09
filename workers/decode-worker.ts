import { extractLSBs } from "../lib/stego-embed";
import { TILE, DEFAULT_BITS } from "../lib/constants";
import { decodeWithMetadata } from "../lib/file-format";

interface DecodeMessage {
  type: string;
  imageURL: string;
  bits: number;
}

self.onmessage = async ({ data }: MessageEvent<DecodeMessage>) => {
  if (data.type !== "decode") return;
  
  const bits = data.bits || DEFAULT_BITS;
  
  try {
    // Load the PNG image
    const imgResp = await fetch(data.imageURL);
    const imgBlob = await imgResp.blob();
    const bmp = await createImageBitmap(imgBlob);
    
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const imageData = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    
    postMessage({ pct: 0.2 }); // 20% after loading image
    
    // Calculate how many tiles we have
    const cols = Math.ceil(imageData.width / TILE);
    const rows = Math.ceil(imageData.height / TILE);
    const totalTiles = cols * rows;
    
    // Calculate tile capacity based on bits per channel
    const TILE_CAPACITY = (TILE * TILE * 3 * bits) >> 3;
    
    // Extract data from each tile
    const extractedChunks: Uint8Array[] = [];
    let tileIndex = 0;
    let totalExtracted = 0;
    
    console.log(`\n=== DECODING SETUP ===`);
    console.log(`Image dimensions: ${imageData.width}x${imageData.height}`);
    console.log(`Grid: ${cols}x${rows} = ${totalTiles} tiles`);
    console.log(`Tile capacity: ${TILE_CAPACITY} bytes per tile`);
    console.log(`Expected ${totalTiles * TILE_CAPACITY} bytes total`);
    console.log(`Bits per channel: ${bits}`);
    
    const decodeStartTime = Date.now();
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tileX = col * TILE;
        const tileY = row * TILE;
        const tileWidth = Math.min(TILE, imageData.width - tileX);
        const tileHeight = Math.min(TILE, imageData.height - tileY);
        
        if (tileWidth <= 0 || tileHeight <= 0) {
          console.warn(`Skipping invalid tile ${tileIndex} at (${tileX}, ${tileY})`);
          continue;
        }
        
        // Extract the tile region
        const tileCanvas = new OffscreenCanvas(TILE, TILE);
        const tileCtx = tileCanvas.getContext("2d")!;
        
        // Initialize with white background
        tileCtx.fillStyle = 'white';
        tileCtx.fillRect(0, 0, TILE, TILE);
        
        // Copy the tile region from imageData
        if (tileWidth > 0 && tileHeight > 0) {
          // Create a temporary canvas for the partial tile
          const tempCanvas = new OffscreenCanvas(tileWidth, tileHeight);
          const tempCtx = tempCanvas.getContext("2d")!;
          
          // Put the image data with negative offset to get the tile region
          tempCtx.putImageData(imageData, -tileX, -tileY);
          
          // Draw onto the full tile canvas
          tileCtx.drawImage(tempCanvas, 0, 0);
        }
        
        // Get the tile data
        const tileData = tileCtx.getImageData(0, 0, TILE, TILE);
        
        // Debug: Check first few pixels before extraction
        if (tileIndex === 0) {
          console.log(`[decode] Tile 0 first 10 pixels (RGBA):`);
          for (let i = 0; i < 40; i += 4) {
            console.log(`  Pixel ${i/4}: R=${tileData.data[i]}, G=${tileData.data[i+1]}, B=${tileData.data[i+2]}, A=${tileData.data[i+3]}`);
          }
        }
        
        // Extract LSBs from the tile - ALWAYS extract full TILE_CAPACITY
        const extracted = extractLSBs(tileData.data, bits);
        
        // Always use the full extracted data - matches encoding
        extractedChunks.push(extracted);
        totalExtracted += extracted.length;
        
        // Only log for first few tiles to reduce overhead
        if (tileIndex < 3 || tileIndex === totalTiles - 1) {
          console.log(`Extracting tile ${tileIndex} at (${col},${row}) -> (${tileX}, ${tileY})`);
        }
        
        if (tileIndex < 5 || tileIndex >= totalTiles - 2) {
          const hexDump = Array.from(extracted.slice(0, Math.min(20, extracted.length)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(' ');
          console.log(`  First 20 bytes: ${hexDump}`);
          
          // For the first tile, check if it contains the STEGO header
          if (tileIndex === 0) {
            const headerBytes = extracted.slice(0, 19);
            const headerHex = Array.from(headerBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`  METADATA HEADER: ${headerHex}`);
          }
        }
        
        tileIndex++;
        
        // Update progress every 10 tiles with detailed status
        if (tileIndex % 10 === 0 || tileIndex === 1 || tileIndex === totalTiles) {
          const progress = tileIndex / totalTiles;
          const elapsed = (Date.now() - decodeStartTime) / 1000;
          const tilesPerSecond = tileIndex / elapsed;
          const remainingTiles = totalTiles - tileIndex;
          const eta = remainingTiles / tilesPerSecond;
          
          postMessage({ 
            pct: 0.2 + progress * 0.6, // 20% to 80% for extraction
            status: `Extracting tile ${tileIndex}/${totalTiles} (${Math.round(progress * 100)}%) - ${eta > 1 ? Math.round(eta) + 's remaining' : 'finishing...'}`
          });
        }
      }
    }
    
    console.log(`\n=== DECODING COMPLETE ===`);
    console.log(`Processed ${tileIndex} tiles out of ${totalTiles} expected`);
    console.log(`Extracted ${extractedChunks.length} chunks`);
    console.log(`Total bytes extracted: ${totalExtracted}`);
    if (tileIndex !== totalTiles) {
      console.error(`TILE COUNT MISMATCH! Processed ${tileIndex} but expected ${totalTiles}`);
    }
    
    console.log(`\n=== DECODE SUMMARY ===`);
    console.log(`Extracted ${extractedChunks.length} chunks, total: ${totalExtracted} bytes`);
    console.log(`Image dimensions: ${imageData.width}x${imageData.height}`);
    console.log(`Tile grid: ${cols}x${rows} = ${cols * rows} tiles`);
    
    // Log chunk sizes
    console.log(`\nChunk sizes:`);
    for (let i = 0; i < Math.min(10, extractedChunks.length); i++) {
      console.log(`  Chunk ${i}: ${extractedChunks[i].length} bytes`);
    }
    if (extractedChunks.length > 10) {
      console.log(`  ... (${extractedChunks.length - 10} more chunks)`);
    }
    
    // Concatenate all extracted data
    const fullData = new Uint8Array(totalExtracted);
    let offset = 0;
    for (const chunk of extractedChunks) {
      fullData.set(chunk, offset);
      offset += chunk.length;
    }
    
    console.log(`\nTotal concatenated: ${offset} bytes`);
    
    // Log the beginning of concatenated data
    const concatHex = Array.from(fullData.slice(0, Math.min(100, fullData.length)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
    console.log(`First 100 bytes of concatenated data: ${concatHex}`);
    
    postMessage({ pct: 0.9 }); // 90% before processing data
    
    // Try to decode with metadata
    console.log(`\n=== METADATA DECODING ===`);
    
    // First, we need to find where the actual data ends
    // Look for the metadata header to determine actual data size
    let actualDataEnd = fullData.length;
    
    // Check if we have STEGO3 header
    const MAGIC_MARKER = new Uint8Array([0x53, 0x54, 0x45, 0x47, 0x4F, 0x33]);
    let hasMarker = true;
    for (let i = 0; i < MAGIC_MARKER.length && i < fullData.length; i++) {
      if (fullData[i] !== MAGIC_MARKER[i]) {
        hasMarker = false;
        break;
      }
    }
    
    if (hasMarker && fullData.length >= 19) {
      // Read the compressed size from header to know how much data to use
      const view = new DataView(fullData.buffer, fullData.byteOffset, fullData.byteLength);
      const compressedSize = view.getUint32(15, true);
      actualDataEnd = 19 + compressedSize; // header + data
      console.log(`Found STEGO3 header, actual data size: ${actualDataEnd} bytes (header: 19, data: ${compressedSize})`);
      console.log(`Total extracted: ${fullData.length} bytes, using first ${actualDataEnd} bytes`);
    }
    
    // Only use the actual data, not the padding
    const trimmedData = fullData.slice(0, actualDataEnd);
    
    const decoded = decodeWithMetadata(trimmedData);
    let actualData: Uint8Array;
    
    if (decoded) {
      console.log(`Successfully decoded with metadata:`);
      console.log(`  Original size from metadata: ${decoded.metadata.originalSize} bytes`);
      console.log(`  Compressed: ${decoded.metadata.compressed || false}`);
      console.log(`  Compressed size: ${decoded.metadata.compressedSize || 'N/A'} bytes`);
      console.log(`  Actual extracted data size: ${decoded.data.length} bytes`);
      console.log(`  Total data with metadata: ${fullData.length} bytes`);
      console.log(`  Checksum present: ${decoded.metadata.checksum !== undefined}`);
      
      // Handle decompression if needed
      if (decoded.metadata.compressed) {
        console.log('WARNING: Data marked as compressed but compression has been removed');
        actualData = decoded.data;
      } else {
        actualData = decoded.data;
        // Verify the data matches expected size
        if (actualData.length !== decoded.metadata.originalSize) {
          console.error(`  WARNING: Size mismatch! Expected ${decoded.metadata.originalSize}, got ${actualData.length}`);
        }
      }
    } else {
      console.log('No metadata found, using raw data');
      actualData = fullData;
    }
    
    // Try to detect file type from magic numbers
    const fileInfo = detectFileType(actualData);
    
    // Log first few bytes for debugging
    const firstBytes = Array.from(actualData.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('First 20 bytes:', firstBytes);
    console.log('Detected type:', fileInfo.description);
    
    // Create blob with detected MIME type
    const blob = new Blob([actualData], { type: fileInfo.mimeType });
    
    postMessage({ 
      done: true, 
      blob,
      suggestedName: fileInfo.suggestedName,
      fileSize: actualData.length,
      detectedType: fileInfo.description
    });
    
  } catch (error) {
    postMessage({ 
      error: `Failed to decode: ${error instanceof Error ? error.message : 'Unknown error'}` 
    });
  }
};

// Detect file type from magic numbers
function detectFileType(data: Uint8Array): { 
  mimeType: string; 
  extension: string; 
  description: string;
  suggestedName: string;
} {
  // Check for common file signatures (magic numbers)
  const signatures: Array<{
    bytes: number[];
    mimeType: string;
    extension: string;
    description: string;
  }> = [
    // Images
    { bytes: [0xFF, 0xD8, 0xFF], mimeType: 'image/jpeg', extension: 'jpg', description: 'JPEG Image' },
    { bytes: [0x89, 0x50, 0x4E, 0x47], mimeType: 'image/png', extension: 'png', description: 'PNG Image' },
    { bytes: [0x47, 0x49, 0x46, 0x38], mimeType: 'image/gif', extension: 'gif', description: 'GIF Image' },
    { bytes: [0x42, 0x4D], mimeType: 'image/bmp', extension: 'bmp', description: 'BMP Image' },
    
    // Documents
    { bytes: [0x25, 0x50, 0x44, 0x46], mimeType: 'application/pdf', extension: 'pdf', description: 'PDF Document' },
    { bytes: [0x50, 0x4B, 0x03, 0x04], mimeType: 'application/zip', extension: 'zip', description: 'ZIP Archive' },
    { bytes: [0x50, 0x4B, 0x05, 0x06], mimeType: 'application/zip', extension: 'zip', description: 'ZIP Archive (empty)' },
    { bytes: [0x50, 0x4B, 0x07, 0x08], mimeType: 'application/zip', extension: 'zip', description: 'ZIP Archive (spanned)' },
    
    // Microsoft Office
    { bytes: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], mimeType: 'application/vnd.ms-office', extension: 'doc', description: 'Microsoft Office Document' },
    
    // Compressed
    { bytes: [0x1F, 0x8B], mimeType: 'application/gzip', extension: 'gz', description: 'GZIP Archive' },
    { bytes: [0x42, 0x5A, 0x68], mimeType: 'application/x-bzip2', extension: 'bz2', description: 'BZIP2 Archive' },
    { bytes: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], mimeType: 'application/x-7z-compressed', extension: '7z', description: '7-Zip Archive' },
    { bytes: [0x52, 0x61, 0x72, 0x21], mimeType: 'application/x-rar-compressed', extension: 'rar', description: 'RAR Archive' },
    
    // Zstandard
    { bytes: [0x28, 0xB5, 0x2F, 0xFD], mimeType: 'application/zstd', extension: 'zst', description: 'Zstandard Compressed' },
    
    // Text
    { bytes: [0xEF, 0xBB, 0xBF], mimeType: 'text/plain', extension: 'txt', description: 'UTF-8 Text with BOM' },
    
    // Executables
    { bytes: [0x4D, 0x5A], mimeType: 'application/x-msdownload', extension: 'exe', description: 'Windows Executable' },
    { bytes: [0x7F, 0x45, 0x4C, 0x46], mimeType: 'application/x-elf', extension: 'elf', description: 'ELF Executable' },
    
    // Media
    { bytes: [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70], mimeType: 'video/mp4', extension: 'mp4', description: 'MP4 Video' },
    { bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], mimeType: 'video/mp4', extension: 'mp4', description: 'MP4 Video' },
    { bytes: [0x49, 0x44, 0x33], mimeType: 'audio/mpeg', extension: 'mp3', description: 'MP3 Audio' },
    { bytes: [0xFF, 0xFB], mimeType: 'audio/mpeg', extension: 'mp3', description: 'MP3 Audio' },
    { bytes: [0x4F, 0x67, 0x67, 0x53], mimeType: 'audio/ogg', extension: 'ogg', description: 'OGG Audio' },
    
    // Data formats
    { bytes: [0x7B, 0x22], mimeType: 'application/json', extension: 'json', description: 'JSON Data' }, // {"
    { bytes: [0x7B, 0x0A], mimeType: 'application/json', extension: 'json', description: 'JSON Data' }, // {\n
    { bytes: [0x5B], mimeType: 'application/json', extension: 'json', description: 'JSON Array' }, // [
  ];
  
  // Check each signature
  for (const sig of signatures) {
    if (data.length >= sig.bytes.length) {
      let match = true;
      for (let i = 0; i < sig.bytes.length; i++) {
        if (data[i] !== sig.bytes[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        return {
          mimeType: sig.mimeType,
          extension: sig.extension,
          description: sig.description,
          suggestedName: `decoded_data.${sig.extension}`
        };
      }
    }
  }
  
  // Check if it's likely text (printable ASCII)
  let isLikelyText = true;
  const sampleSize = Math.min(1000, data.length);
  for (let i = 0; i < sampleSize; i++) {
    const byte = data[i];
    // Check if byte is printable ASCII or common whitespace
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
      isLikelyText = false;
      break;
    }
    if (byte > 0x7E && byte < 0x80) {
      isLikelyText = false;
      break;
    }
  }
  
  if (isLikelyText) {
    return {
      mimeType: 'text/plain',
      extension: 'txt',
      description: 'Plain Text',
      suggestedName: 'decoded_data.txt'
    };
  }
  
  // Default to binary
  return {
    mimeType: 'application/octet-stream',
    extension: 'bin',
    description: 'Binary Data',
    suggestedName: 'decoded_data.bin'
  };
}