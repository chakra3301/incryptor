import { embedTile } from "../lib/stego-embed";
import { paintPointillistCanvas } from "../lib/pointillist";
import { TILE, DEFAULT_BITS, CHUNK, MAX_CANVAS } from "../lib/constants";
import { encodeWithMetadata } from "../lib/file-format";

interface EncodeMessage {
  type: string;
  dataURL: string;
  imageURL?: string;
  bits?: number;
  autoExpand?: boolean;
}

self.onmessage = async ({ data }: MessageEvent<EncodeMessage>) => {
  if (data.type !== "encode") return;

  const bits = data.bits || DEFAULT_BITS;
  const autoExpand = data.autoExpand ?? true;

  // Load the data file
  const dataResp = await fetch(data.dataURL);
  const dataReader = dataResp.body!.getReader();
  const dataTotal = +dataResp.headers.get("Content-Length")!;

  const tiles: Blob[] = [];
  let read = 0;

  // For large files, we'll process in chunks to avoid loading everything into memory
  const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks
  const isLargeFile = dataTotal > 100 * 1024 * 1024; // 100MB threshold

  let rawFileData: Uint8Array;

  if (isLargeFile) {
    console.log(
      `Large file detected (${(dataTotal / 1024 / 1024).toFixed(
        1
      )}MB), using chunked processing`
    );

    // For now, we still need to load the full file for compression
    // But we can process it more efficiently
    const chunks: Uint8Array[] = [];

    while (true) {
      const { value, done } = await dataReader.read();
      if (done) break;
      read += value.length;
      chunks.push(value);
      postMessage({
        pct: (read / dataTotal) * 0.25,
        status: `Loading: ${(read / 1024 / 1024).toFixed(1)}MB / ${(
          dataTotal /
          1024 /
          1024
        ).toFixed(1)}MB`,
      });
    }

    // Concatenate chunks
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    rawFileData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      rawFileData.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    // Small files - load normally
    const chunks: Uint8Array[] = [];

    while (true) {
      const { value, done } = await dataReader.read();
      if (done) break;
      read += value.length;
      chunks.push(value);
      postMessage({ pct: (read / dataTotal) * 0.3 }); // 30% for reading data
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    rawFileData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      rawFileData.set(chunk, offset);
      offset += chunk.length;
    }
  }

  // Log first bytes of original file for debugging
  const firstBytes = Array.from(rawFileData.slice(0, 20))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  console.log("Original file first 20 bytes:", firstBytes);
  console.log("Original file size:", rawFileData.length);

  // Skip compression - use raw data directly
  console.log("Using raw data without compression");
  const compressionStartPct = isLargeFile ? 0.25 : 0.3;
  postMessage({
    pct: compressionStartPct,
    status: `Processing ${(rawFileData.length / 1024 / 1024).toFixed(1)}MB...`,
  });

  // Encode with metadata for proper extraction
  const fileData = encodeWithMetadata(rawFileData, {
    originalSize: rawFileData.length,
    compressed: false,
    compressedSize: rawFileData.length,
  });

  console.log("=== FILE SIZE CALCULATION ===");
  console.log(`Raw file size: ${rawFileData.length.toLocaleString()} bytes`);
  console.log(`With metadata: ${fileData.length.toLocaleString()} bytes`);
  console.log(`Bits per channel: ${bits}`);
  console.log(`Bytes per pixel: ${(3 * bits) / 8}`);
  console.log(`Required pixels: ${Math.ceil((fileData.length * 8) / (3 * bits)).toLocaleString()}`);
  console.log(`Square side needed: ${Math.ceil(Math.sqrt(Math.ceil((fileData.length * 8) / (3 * bits))))}`);
  console.log(`Rounded to TILE: ${Math.ceil(Math.ceil(Math.sqrt(Math.ceil((fileData.length * 8) / (3 * bits)))) / TILE) * TILE}`);

  // Calculate bytes per pixel for the given bits
  const bytesPerPixel = (3 * bits) / 8;
  const minPixelsNeeded = Math.ceil(fileData.length / bytesPerPixel);

  // Calculate canvas dimensions
  let canvasWidth: number, canvasHeight: number;
  let sourceImage: ImageData | undefined;
  let usePointillist = false;

  if (data.imageURL) {
    // Load the source image
    const imgResp = await fetch(data.imageURL);
    const imgBlob = await imgResp.blob();
    const bmp = await createImageBitmap(imgBlob);

    const tempCanvas = new OffscreenCanvas(bmp.width, bmp.height);
    const tempCtx = tempCanvas.getContext("2d")!;
    tempCtx.drawImage(bmp, 0, 0);
    sourceImage = tempCtx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();

    postMessage({ pct: 0.4 }); // 40% after loading image

    // Check if source image has enough capacity
    const sourceCapacity =
      Math.floor((sourceImage.width * sourceImage.height * 3 * bits) / 8);
    
    console.log(`Source image: ${sourceImage.width}×${sourceImage.height}`);
    console.log(`Source capacity: ${(sourceCapacity / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Data size: ${(fileData.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Bits per channel: ${bits}`);

    if (fileData.length <= sourceCapacity) {
      // Source image is large enough - use its exact dimensions
      canvasWidth = sourceImage.width;
      canvasHeight = sourceImage.height;
      console.log(`Using original image dimensions: ${canvasWidth}×${canvasHeight}`);
    } else {
      if (!autoExpand) {
        const overflow = (
          (fileData.length - sourceCapacity) /
          1024 /
          1024
        ).toFixed(2);
        return postMessage({
          error: `Data file is too large for the cover image. The image can hold ${(
            sourceCapacity /
            1024 /
            1024
          ).toFixed(2)} MB but your data is ${(
            fileData.length /
            1024 /
            1024
          ).toFixed(
            2
          )} MB (${overflow} MB overflow). Try increasing bits per channel or use a larger image.`,
        });
      }

      // Need to expand - create square canvas like Python implementation
      // Use the actual fileData length which includes metadata
      const totalDataSize = fileData.length;
      const requiredPixels = Math.ceil((totalDataSize * 8) / (3 * bits));

      let side = Math.ceil(Math.sqrt(requiredPixels));

      // Round up to nearest multiple of TILE for clean grid
      side = Math.ceil(side / TILE) * TILE;

      // Verify capacity and adjust if needed
      let capacity = Math.floor((side * side * 3 * bits) / 8);
      while (totalDataSize > capacity) {
        side += TILE; // Increase by TILE to maintain grid alignment
        capacity = Math.floor((side * side * 3 * bits) / 8);
        if (side > MAX_CANVAS) {
          return postMessage({
            error: `Required canvas size ${side}×${side} exceeds limit of ${MAX_CANVAS}×${MAX_CANVAS}`,
          });
        }
      }

      canvasWidth = side;
      canvasHeight = side;
      usePointillist = true;

      console.log(
        `Expanding from ${sourceImage.width}×${sourceImage.height} to ${canvasWidth}×${canvasHeight} (square canvas)`
      );
    }
  } else {
    // No source image - create square canvas
    const totalDataSize = fileData.length;
    const requiredPixels = Math.ceil((totalDataSize * 8) / (3 * bits));

    let side = Math.ceil(Math.sqrt(requiredPixels));

    // Round up to nearest multiple of TILE for clean grid
    side = Math.ceil(side / TILE) * TILE;

    // Verify capacity
    let capacity = Math.floor((side * side * 3 * bits) / 8);
    while (totalDataSize > capacity) {
      side += TILE;
      capacity = Math.floor((side * side * 3 * bits) / 8);
    }

    canvasWidth = side;
    canvasHeight = side;
  }

  // Check canvas size limits
  if (canvasWidth > MAX_CANVAS || canvasHeight > MAX_CANVAS) {
    return postMessage({
      error: `Canvas ${canvasWidth}×${canvasHeight} exceeds GPU limit of ${MAX_CANVAS}×${MAX_CANVAS}`,
    });
  }

  // Calculate tile grid
  const cols = Math.ceil(canvasWidth / TILE);
  const rows = Math.ceil(canvasHeight / TILE);

  // Create the full canvas image if using pointillist expansion
  let fullCanvasData: ImageData | undefined;

  if (sourceImage && usePointillist) {
    // Create pointillist painting on the expanded canvas
    // Calculate optimal number of dots based on expansion ratio
    const expansionRatio =
      (canvasWidth * canvasHeight) / (sourceImage.width * sourceImage.height);
    const baseDots = Math.max(10000, (canvasWidth * canvasHeight) >> 3); // More dots for quality
    const dots = Math.floor(baseDots * Math.min(2, expansionRatio)); // Scale dots with expansion

    // Use larger dots with less jitter for smoother appearance
    const dotRadius = expansionRatio > 4 ? 2 : 1; // Larger dots for big expansions
    const jitterAmount = bits <= 4 ? 2 : 4; // Less jitter when preserving quality

    const pointillistData = paintPointillistCanvas(
      sourceImage,
      canvasWidth,
      canvasHeight,
      dots,
      jitterAmount,
      dotRadius
    );
    fullCanvasData = new ImageData(pointillistData, canvasWidth, canvasHeight);
  } else if (sourceImage) {
    // Need to ensure the canvas is the full size, not just source image size
    if (
      sourceImage.width === canvasWidth &&
      sourceImage.height === canvasHeight
    ) {
      // Source image already matches canvas size
      fullCanvasData = sourceImage;
    } else {
      // Need to expand - use pointillist to fill the entire canvas
      console.log(`Creating pointillist expansion from ${sourceImage.width}x${sourceImage.height} to ${canvasWidth}x${canvasHeight}`);
      
      const expansionRatio = (canvasWidth * canvasHeight) / (sourceImage.width * sourceImage.height);
      const baseDots = Math.max(10000, (canvasWidth * canvasHeight) >> 3);
      const dots = Math.floor(baseDots * Math.min(2, expansionRatio));
      const dotRadius = expansionRatio > 4 ? 2 : 1;
      const jitterAmount = bits <= 4 ? 2 : 4;
      
      const pointillistData = paintPointillistCanvas(
        sourceImage,
        canvasWidth,
        canvasHeight,
        dots,
        jitterAmount,
        dotRadius
      );
      fullCanvasData = new ImageData(pointillistData, canvasWidth, canvasHeight);
      
      console.log(
        `Canvas is now a perfect ${cols}x${rows} grid of ${TILE}x${TILE} tiles with pointillist fill`
      );
    }
  }

  // Calculate tiles needed
  const TILE_CAPACITY = Math.floor((TILE * TILE * 3 * bits) / 8); // bytes per tile
  const totalTilesNeeded = Math.ceil(fileData.length / TILE_CAPACITY);

  console.log(`\n=== ENCODING SETUP ===`);
  console.log(`Total data size: ${fileData.length} bytes`);
  console.log(`Canvas dimensions: ${canvasWidth}x${canvasHeight}`);
  console.log(`Tile capacity: ${TILE_CAPACITY} bytes per tile`);
  console.log(`Total tiles needed for data: ${totalTilesNeeded}`);
  console.log(`Grid: ${cols}x${rows} = ${cols * rows} tiles`);
  console.log(`Total capacity: ${cols * rows * TILE_CAPACITY} bytes`);

  // Process data tile by tile - all tiles are now TILE×TILE
  let dataOffset = 0;
  let tileIndex = 0;
  const totalTiles = rows * cols;
  
  console.log(`Processing ${totalTiles} tiles...`);
  const startTime = Date.now();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileX = col * TILE;
      const tileY = row * TILE;

      // All tiles are now guaranteed to be TILE×TILE
      const tileData = new Uint8Array(TILE_CAPACITY);

      // Copy available data into this tile
      const remainingData = fileData.length - dataOffset;
      const dataForTile = Math.min(TILE_CAPACITY, remainingData);

      if (dataForTile > 0) {
        tileData.set(fileData.subarray(dataOffset, dataOffset + dataForTile));
        
        // If this tile is partially filled, add subtle random noise to the empty portion
        // This helps blend the boundary between data and no-data regions
        if (dataForTile < TILE_CAPACITY) {
          // Use a seeded random based on tile position for consistency
          const seed = tileX * 31337 + tileY * 42069;
          let rand = seed;
          
          // Fill remaining bytes with pseudo-random data
          for (let i = dataForTile; i < TILE_CAPACITY; i++) {
            // Simple linear congruential generator
            rand = (rand * 1103515245 + 12345) & 0x7fffffff;
            // Use low bits for subtle noise (0-15 range)
            tileData[i] = (rand & 0x0F);
          }
        }
      } else {
        // Empty tile - fill with subtle random pattern
        const seed = tileX * 31337 + tileY * 42069;
        let rand = seed;
        
        for (let i = 0; i < TILE_CAPACITY; i++) {
          rand = (rand * 1103515245 + 12345) & 0x7fffffff;
          // Even more subtle noise for empty tiles (0-7 range)
          tileData[i] = (rand & 0x07);
        }
      }

      // Only log for first few tiles to reduce overhead
      if (tileIndex < 3 || tileIndex === totalTiles - 1) {
        console.log(`\n=== ENCODE Tile ${tileIndex} at (${col},${row}) ===`);
        console.log(`  Position: (${tileX}, ${tileY})`);
        console.log(`  Data bytes: ${dataForTile} bytes`);
        console.log(
          `  Byte range: [${dataOffset}, ${dataOffset + dataForTile})`
        );

        // For the first tile, check if it contains the STEGO3 header
        if (tileIndex === 0 && dataForTile >= 19) {
          const headerBytes = fileData.slice(0, 19);
          const headerHex = Array.from(headerBytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ");
          console.log(`  METADATA HEADER: ${headerHex}`);
        }
      }

      const url = await embedTile(tileData, bits, fullCanvasData, tileX, tileY);

      // Skip verification for performance - only verify first tile
      if (false && tileIndex === 0 && dataForTile > 0) {
        const testResp = await fetch(url);
        const testBlob = await testResp.blob();
        const testBmp = await createImageBitmap(testBlob);
        const testCanvas = new OffscreenCanvas(TILE, TILE);
        const testCtx = testCanvas.getContext("2d")!;
        testCtx.drawImage(testBmp, 0, 0);
        const testImageData = testCtx.getImageData(0, 0, TILE, TILE);
        testBmp.close();

        // Extract LSBs to verify
        const { extractLSBs } = await import("../lib/stego-embed");
        const testExtracted = extractLSBs(testImageData.data, bits);

        console.log(`[VERIFY] Tile 0 embedded vs extracted:`);
        console.log(
          `  Original first 20 bytes: ${Array.from(tileData.slice(0, 20))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ")}`
        );
        console.log(
          `  Extracted first 20 bytes: ${Array.from(testExtracted.slice(0, 20))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ")}`
        );

        // Check if they match
        let mismatchFound = false;
        for (let i = 0; i < Math.min(100, dataForTile); i++) {
          if (tileData[i] !== testExtracted[i]) {
            console.error(
              `  MISMATCH at byte ${i}: expected ${tileData[i]
                .toString(16)
                .padStart(2, "0")}, got ${testExtracted[i]
                .toString(16)
                .padStart(2, "0")}`
            );
            mismatchFound = true;
            break;
          }
        }
        if (!mismatchFound) {
          console.log(`  First 100 bytes match correctly!`);
        }
      }

      tiles.push(await (await fetch(url)).blob());
      URL.revokeObjectURL(url);

      // Skip verbose logging to improve performance

      dataOffset += dataForTile;
      tileIndex++;
      
      // Update progress every 10 tiles or at important milestones
      if (tileIndex % 10 === 0 || tileIndex === 1 || tileIndex === totalTiles) {
        const progress = tileIndex / totalTiles;
        const elapsed = (Date.now() - startTime) / 1000;
        const tilesPerSecond = tileIndex / elapsed;
        const remainingTiles = totalTiles - tileIndex;
        const eta = remainingTiles / tilesPerSecond;
        
        postMessage({ 
          pct: 0.4 + progress * 0.4, // 40% to 80% for tiles
          status: `Encoding tile ${tileIndex}/${totalTiles} (${Math.round(progress * 100)}%) - ${eta > 1 ? Math.round(eta) + 's remaining' : 'finishing...'}`
        });
      }
    }
  }

  console.log(`\n=== FINAL ASSEMBLY ===`);
  console.log(
    `Total data processed: ${dataOffset} bytes out of ${fileData.length} bytes`
  );
  console.log(`Canvas dimensions: ${canvasWidth}x${canvasHeight}`);
  console.log(`Tiles created: ${tiles.length}`);
  console.log(`Expected tiles: ${rows * cols}`);

  if (tiles.length !== rows * cols) {
    console.error(
      `TILE COUNT MISMATCH! Created ${tiles.length} but expected ${rows * cols}`
    );
  }

  // Create final canvas at exact dimensions
  const finalCanvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const finalCtx = finalCanvas.getContext("2d")!;

  // Don't fill with red - that might interfere with the data
  // The canvas starts transparent/black by default

  // Draw tiles - ensure we handle edge tiles properly
  let i = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (i >= tiles.length) {
        console.error(`Ran out of tiles at row ${row}, col ${col} (tile ${i})`);
        break;
      }

      const tileX = col * TILE;
      const tileY = row * TILE;

      // Calculate how much of this tile fits in the canvas
      const drawWidth = Math.min(TILE, canvasWidth - tileX);
      const drawHeight = Math.min(TILE, canvasHeight - tileY);

      const blob = tiles[i];
      const bmp = await createImageBitmap(blob);

      // Only log first few tiles
      if (i < 3) {
        console.log(
          `Drawing tile ${i} at row ${row}, col ${col} -> (${tileX}, ${tileY})`
        );
      }

      // Draw the full tile
      finalCtx.drawImage(bmp, tileX, tileY);

      bmp.close();
      i++;
    }
  }

  console.log(`Drew ${i} tiles out of ${tiles.length} total`);

  postMessage({ pct: 0.9 }); // 90% before final PNG

  try {
    console.log(`Attempting to convert ${canvasWidth}x${canvasHeight} canvas to PNG...`);
    const finalPng = await finalCanvas.convertToBlob({
      type: "image/png",
      quality: 1.0,
    });
    console.log(`Successfully created PNG blob of size: ${finalPng.size} bytes`);
    postMessage({ done: true, png: finalPng });
  } catch (error) {
    console.error("Failed to convert canvas to PNG:", error);
    postMessage({ 
      error: `Failed to create PNG image. The canvas size (${canvasWidth}×${canvasHeight}) may exceed browser limits. Try using a smaller file or increasing bits per channel.` 
    });
  }
};
