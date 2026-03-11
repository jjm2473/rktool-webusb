import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { GzipStream } from '../../src/gzip-stream.js';
import { NodeBlob } from '../../src/node-blob.js';

function createPayload(size) {
  const payload = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    payload[index] = index % 251;
  }
  return payload;
}

function appendOpenWrtMetadata(gzipBytes, blockSizes) {
  const normalizedBlocks = Array.isArray(blockSizes) ? blockSizes : [];
  const totalMetadataSize = normalizedBlocks.reduce((sum, size) => sum + size, 0);
  const output = new Uint8Array(gzipBytes.byteLength + totalMetadataSize);
  output.set(gzipBytes, 0);

  let writeOffset = gzipBytes.byteLength;
  for (const blockSize of normalizedBlocks) {
    const metadataBlock = new Uint8Array(blockSize);
    metadataBlock.fill(0x5a, 0, Math.max(0, blockSize - 16));
    metadataBlock[blockSize - 16] = 0x46; // F
    metadataBlock[blockSize - 15] = 0x57; // W
    metadataBlock[blockSize - 14] = 0x78; // x
    metadataBlock[blockSize - 13] = 0x30; // 0
    metadataBlock[blockSize - 4] = (blockSize >>> 24) & 0xff;
    metadataBlock[blockSize - 3] = (blockSize >>> 16) & 0xff;
    metadataBlock[blockSize - 2] = (blockSize >>> 8) & 0xff;
    metadataBlock[blockSize - 1] = blockSize & 0xff;

    output.set(metadataBlock, writeOffset);
    writeOffset += blockSize;
  }

  return output;
}

async function withTempGzip(payload, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rktool-gzip-'));
  const gzipPath = path.join(tempDir, 'payload.bin.gz');

  try {
    await fs.writeFile(gzipPath, gzipSync(payload));
    const sourceBlob = new NodeBlob(gzipPath);
    try {
      return await callback(sourceBlob, gzipPath);
    } finally {
      sourceBlob.close();
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function withTempGzipBytes(gzipBytes, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rktool-gzip-'));
  const gzipPath = path.join(tempDir, 'payload.bin.gz');

  try {
    await fs.writeFile(gzipPath, gzipBytes);
    const sourceBlob = new NodeBlob(gzipPath);
    try {
      return await callback(sourceBlob, gzipPath);
    } finally {
      sourceBlob.close();
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('constructor resolves uncompressed size hint from gzip trailer', async () => {
  const payload = createPayload(12345);

  await withTempGzip(payload, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);
    assert.equal(stream.uncompressedSize, payload.byteLength);
  });
});

test('constructor rejects path-string source in node runtime', async () => {
  const payload = createPayload(256);

  await withTempGzip(payload, async (_gzipBlob, gzipPath) => {
    assert.throws(() => new GzipStream(gzipPath), /Blob-like/);
  });
});

test('constructor ignores OpenWrt metadata footer chain and corrects sizes', async () => {
  const payload = createPayload(12000);
  const rawGzip = gzipSync(payload);
  const metadataBlocks = [64, 96, 160];
  const metadataSize = metadataBlocks.reduce((sum, size) => sum + size, 0);
  const withMetadata = appendOpenWrtMetadata(rawGzip, metadataBlocks);

  await withTempGzipBytes(withMetadata, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);

    assert.equal(stream.metadataSize, metadataSize);
    assert.equal(stream.compressedSize, rawGzip.byteLength);
    assert.equal(stream.uncompressedSize, payload.byteLength);

    stream.open();
    try {
      const output = new Uint8Array(payload.byteLength + 128);
      let totalRead = 0;
      while (totalRead < output.byteLength) {
        const bytesRead = stream.read(output, totalRead, 257, totalRead);
        if (bytesRead === 0) {
          break;
        }
        totalRead += bytesRead;
      }

      assert.equal(totalRead, payload.byteLength);
      assert.deepEqual(output.subarray(0, totalRead), payload);
    } finally {
      stream.close();
    }
  });
});

test('open prefetches 4KB and read supports cache + sequential mode', async () => {
  const payload = createPayload(8192);

  await withTempGzip(payload, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);
    const openResult = stream.open();
    assert.equal(openResult, undefined);

    try {
      const head = new Uint8Array(32);
      const headRead = stream.read(head, 0, head.byteLength, 0);
      assert.equal(headRead, 32);
      assert.deepEqual(head, payload.subarray(0, 32));

      const cachedRange = new Uint8Array(64);
      const cachedRead = stream.read(cachedRange, 0, cachedRange.byteLength, 1500);
      assert.equal(cachedRead, 64);
      assert.deepEqual(cachedRange, payload.subarray(1500, 1564));

      const cachedReadRewind = stream.read(cachedRange, 0, cachedRange.byteLength, 1100);
      assert.equal(cachedReadRewind, 64);
      assert.deepEqual(cachedRange, payload.subarray(1100, 1164));

      const crossBoundary = new Uint8Array(300);
      const crossRead = stream.read(crossBoundary, 0, crossBoundary.byteLength, 3900);
      assert.equal(crossRead, 300);
      assert.deepEqual(crossBoundary, payload.subarray(3900, 4200));

      const sequential = new Uint8Array(100);
      const sequentialRead = stream.read(sequential, 0, sequential.byteLength, 4200);
      assert.equal(sequentialRead, 100);
      assert.deepEqual(sequential, payload.subarray(4200, 4300));

      const stillCached = new Uint8Array(16);
      const stillCachedRead = stream.read(stillCached, 0, stillCached.byteLength, 64);
      assert.equal(stillCachedRead, 16);
      assert.deepEqual(stillCached, payload.subarray(64, 80));
    } finally {
      const closeResult = stream.close();
      assert.equal(closeResult, undefined);
    }
  });
});

test('read rejects non-sequential access beyond cached prefix', async () => {
  const payload = createPayload(7000);

  await withTempGzip(payload, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);
    stream.open();

    try {
      const firstChunk = new Uint8Array(128);
      const firstRead = stream.read(firstChunk, 0, firstChunk.byteLength, 4096);
      assert.equal(firstRead, 128);
      assert.deepEqual(firstChunk, payload.subarray(4096, 4224));

      assert.throws(
        () => stream.read(new Uint8Array(16), 0, 16, 5000),
        /must be sequential/
      );
    } finally {
      stream.close();
    }
  });
});

test('short payload reads from cache and returns 0 at EOF', async () => {
  const payload = createPayload(1024);

  await withTempGzip(payload, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);
    stream.open();

    try {
      const target = new Uint8Array(1500);
      const readLength = stream.read(target, 0, target.byteLength, 0);
      assert.equal(readLength, 1024);
      assert.deepEqual(target.subarray(0, 1024), payload);

      const eofRead = stream.read(target, 0, 64, 1024);
      assert.equal(eofRead, 0);

      const afterEofRead = stream.read(target, 0, 64, 4096);
      assert.equal(afterEofRead, 0);
    } finally {
      stream.close();
    }
  });
});
