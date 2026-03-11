/**
 * 仅支持在Nodejs或者浏览器Worker环境中使用，主线程浏览器环境不支持同步读取Blob，无法使用GzipStream
 */
import { NodeBlobReaderSync } from './node-blob.js';

const DEFAULT_PREFIX_CACHE_SIZE = 4 * 1024;
const DEFAULT_COMPRESSED_CHUNK_SIZE = 64 * 1024;
const OPENWRT_METADATA_MAGIC = [0x46, 0x57, 0x78, 0x30]; // "FWx0"
const OPENWRT_METADATA_FOOTER_SIZE = 16;
const OPENWRT_METADATA_MAX_TOTAL_SIZE = 32 * 1024;

function isNodeRuntime() {
	return typeof process !== 'undefined' && !!(process.versions && process.versions.node);
}

let nodeRequire = null;
if (isNodeRuntime()) {
	const { createRequire } = await import('node:module');
	nodeRequire = createRequire(import.meta.url);
}

function normalizeSize(value, fallback) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return fallback;
	}
	return Math.trunc(parsed);
}

function normalizePositiveSize(value, fallback) {
	const size = normalizeSize(value, fallback);
	if (size <= 0) {
		return fallback;
	}
	return size;
}

function toUint8Array(chunk) {
	if (!chunk) {
		return new Uint8Array(0);
	}
	if (chunk instanceof Uint8Array) {
		return chunk;
	}
	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}
	if (chunk instanceof ArrayBuffer) {
		return new Uint8Array(chunk);
	}
	return Uint8Array.from(chunk);
}

function concatChunks(chunks, totalLength) {
	const result = new Uint8Array(totalLength);
	let writeOffset = 0;
	for (const chunk of chunks) {
		result.set(chunk, writeOffset);
		writeOffset += chunk.byteLength;
	}
	return result;
}

function toWritableView(buffer) {
	if (buffer instanceof Uint8Array) {
		return buffer;
	}
	if (ArrayBuffer.isView(buffer)) {
		return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	}
	if (buffer instanceof ArrayBuffer) {
		return new Uint8Array(buffer);
	}
	throw new Error('buffer must be a Uint8Array, Buffer, TypedArray, or ArrayBuffer');
}

function isWorkerLikeRuntime() {
	return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
}

function readUint32LE(bytes, offset) {
	if (!bytes || offset < 0 || bytes.byteLength < offset + 4) {
		return null;
	}
	return (
		(bytes[offset])
		| (bytes[offset + 1] << 8)
		| (bytes[offset + 2] << 16)
		| (bytes[offset + 3] << 24)
	) >>> 0;
}

function readUint32BE(bytes, offset) {
	if (!bytes || offset < 0 || bytes.byteLength < offset + 4) {
		return null;
	}
	return (
		(bytes[offset] << 24)
		| (bytes[offset + 1] << 16)
		| (bytes[offset + 2] << 8)
		| (bytes[offset + 3])
	) >>> 0;
}

function hasOpenWrtMetadataMagic(bytes) {
	return !!bytes
		&& bytes.byteLength >= OPENWRT_METADATA_FOOTER_SIZE
		&& bytes[0] === OPENWRT_METADATA_MAGIC[0]
		&& bytes[1] === OPENWRT_METADATA_MAGIC[1]
		&& bytes[2] === OPENWRT_METADATA_MAGIC[2]
		&& bytes[3] === OPENWRT_METADATA_MAGIC[3];
}

function detectOpenWrtMetadataSize(totalSize, readRange) {
	if (typeof totalSize !== 'number' || totalSize < OPENWRT_METADATA_FOOTER_SIZE || typeof readRange !== 'function') {
		return 0;
	}

	let metadataTotal = 0;
	let cursor = totalSize;

	while (cursor >= OPENWRT_METADATA_FOOTER_SIZE && metadataTotal < OPENWRT_METADATA_MAX_TOTAL_SIZE) {
		const footerOffset = cursor - OPENWRT_METADATA_FOOTER_SIZE;
		const footer = readRange(footerOffset, OPENWRT_METADATA_FOOTER_SIZE);
		if (!hasOpenWrtMetadataMagic(footer)) {
			break;
		}

		const blockSize = readUint32BE(footer, OPENWRT_METADATA_FOOTER_SIZE - 4);
		if (!Number.isFinite(blockSize) || blockSize < OPENWRT_METADATA_FOOTER_SIZE) {
			break;
		}

		if (blockSize > cursor) {
			break;
		}

		if (metadataTotal + blockSize > OPENWRT_METADATA_MAX_TOTAL_SIZE) {
			break;
		}

		metadataTotal += blockSize;
		cursor -= blockSize;
	}

	return metadataTotal;
}

function createUnknownSourceInfo() {
	return {
		sourceSize: 0,
		metadataSize: 0,
		compressedSize: 0,
		uncompressedSize: null,
	};
}

function probeBlobSourceInfo(blob) {
	const sourceSize = normalizeSize(blob?.size, 0);
	if (
		!blob
		|| typeof blob !== 'object'
		|| typeof blob.slice !== 'function'
		|| sourceSize <= 0
	) {
		return {
			sourceSize,
			metadataSize: 0,
			compressedSize: sourceSize,
			uncompressedSize: null,
		};
	}

	try {
		let readRange;

		if (isNodeRuntime()) {
			const reader = new NodeBlobReaderSync();
			readRange = (offset, length) => {
				if (offset < 0 || length <= 0 || offset + length > sourceSize) {
					return null;
				}

				const arrayBuffer = reader.readAsArrayBuffer(blob.slice(offset, offset + length));
				if (!arrayBuffer || arrayBuffer.byteLength !== length) {
					return null;
				}

				return new Uint8Array(arrayBuffer);
			};
		} else {
			if (typeof FileReaderSync !== 'function') {
				return {
					sourceSize,
					metadataSize: 0,
					compressedSize: sourceSize,
					uncompressedSize: null,
				};
			}

			const reader = new FileReaderSync();
			readRange = (offset, length) => {
				if (offset < 0 || length <= 0 || offset + length > sourceSize) {
					return null;
				}

				const arrayBuffer = reader.readAsArrayBuffer(blob.slice(offset, offset + length));
				if (!arrayBuffer || arrayBuffer.byteLength !== length) {
					return null;
				}

				return new Uint8Array(arrayBuffer);
			};
		}

		const metadataSize = detectOpenWrtMetadataSize(sourceSize, readRange);
		const compressedSize = Math.max(0, sourceSize - metadataSize);
		const trailer = compressedSize >= 4
			? readRange(compressedSize - 4, 4)
			: null;
		const uncompressedSize = readUint32LE(trailer, 0);

		return {
			sourceSize,
			metadataSize,
			compressedSize,
			uncompressedSize,
		};
	} catch (_error) {
		return {
			sourceSize,
			metadataSize: 0,
			compressedSize: sourceSize,
			uncompressedSize: null,
		};
	}
}

export function readGzipISizeFromBlob(blob) {
	return probeBlobSourceInfo(blob).uncompressedSize;
}

class SyncBlobChunkReader {
	constructor(source, chunkSize, effectiveSize = null, runtime = 'browser') {
		if (!source || typeof source !== 'object') {
			throw new Error('gzip source must be a File/Blob-like object');
		}
		if (typeof source.slice !== 'function') {
			throw new Error('gzip source must provide Blob.slice() for sync reading');
		}

		this.source = source;
		if (runtime === 'node') {
			this.reader = new NodeBlobReaderSync();
		} else {
			if (typeof FileReaderSync !== 'function') {
				throw new Error('FileReaderSync is required for sync browser gzip reading (Worker runtime only)');
			}
			this.reader = new FileReaderSync();
		}

		const sourceSize = normalizeSize(source.size, 0);
		const safeEffectiveSize = normalizeSize(effectiveSize, sourceSize);
		this.size = Math.max(0, Math.min(sourceSize, safeEffectiveSize));
		this.offset = 0;
		this.eof = this.size === 0;
		this.chunkSize = chunkSize;
	}

	readChunk() {
		if (this.offset >= this.size) {
			this.eof = true;
			return null;
		}

		const end = Math.min(this.offset + this.chunkSize, this.size);
		const blob = this.source.slice(this.offset, end);
		const arrayBuffer = this.reader.readAsArrayBuffer(blob);
		const chunk = new Uint8Array(arrayBuffer);

		this.offset = end;
		this.eof = this.offset >= this.size;

		if (chunk.byteLength <= 0) {
			return null;
		}

		return chunk;
	}

	close() {
	}
}

function resolvePakoInflateCtor(runtime) {
	if (runtime === 'node' && nodeRequire) {
		try {
			const pako = nodeRequire('pako');
			if (typeof pako?.Inflate === 'function') {
				return pako.Inflate;
			}
		} catch (_error) {
		}
	}

	if (typeof globalThis.pako?.Inflate === 'function') {
		return globalThis.pako.Inflate;
	}

	return null;
}

function createPakoInflater(runtime, onData) {
	const InflateCtor = resolvePakoInflateCtor(runtime);
	if (!InflateCtor) {
		throw new Error('Streaming gunzip requires pako (install `pako` in Node.js or provide globalThis.pako.Inflate in Worker)');
	}

	const inflater = new InflateCtor({ gzip: true });
	inflater.onData = (chunk) => {
		onData(toUint8Array(chunk));
	};

	return {
		push(chunk, isLast) {
			inflater.push(chunk, isLast === true);
			if (inflater.err) {
				throw new Error(inflater.msg || `gzip inflate failed (${inflater.err})`);
			}
		},
		close() {
		},
	};
}

export class GzipStream {
	constructor(source, options = {}) {
		if (!source || typeof source !== 'object' || typeof source.slice !== 'function') {
			throw new Error('GzipStream source must be a Blob-like object with slice()');
		}

		this.source = source;
		this._sourceInfo = probeBlobSourceInfo(source);
		this.sourceSize = this._sourceInfo.sourceSize;
		this.metadataSize = this._sourceInfo.metadataSize;
		this.compressedSize = this._sourceInfo.compressedSize;
		this.uncompressedSize = this._sourceInfo.uncompressedSize;
		this.prefixCacheSize = normalizeSize(options.prefixCacheSize, DEFAULT_PREFIX_CACHE_SIZE);
		this.compressedChunkSize = normalizePositiveSize(
			options.compressedChunkSize,
			DEFAULT_COMPRESSED_CHUNK_SIZE
		);
		this.createInflater = typeof options.createInflater === 'function'
			? options.createInflater
			: null;

		this._opened = false;
		this._runtime = null;

		this._prefixCache = new Uint8Array(0);
		this._sequentialPosition = 0;
		this._queue = [];
		this._queueLength = 0;
		this._ended = false;

		this._sourceReader = null;
		this._inflater = null;
	}

	open() {
		if (this._opened) {
			return;
		}

		this._resetReadState();

		try {
			if (isNodeRuntime()) {
				this._runtime = 'node';
				this._sourceReader = new SyncBlobChunkReader(this.source, this.compressedChunkSize, this.compressedSize, 'node');
			} else {
				if (!isWorkerLikeRuntime()) {
					throw new Error('Sync browser gzip reading is only supported in Worker runtime');
				}
				this._runtime = 'browser';
				this._sourceReader = new SyncBlobChunkReader(this.source, this.compressedChunkSize, this.compressedSize, 'browser');
			}

			this._inflater = this._createInflater((chunk) => this._enqueue(chunk));

			this._prefetchPrefix();
			this._sequentialPosition = this._prefixCache.byteLength;
			this._opened = true;
		} catch (error) {
			this._teardown();
			throw error;
		}
	}

	close() {
		this._teardown();
		this._opened = false;
	}

	read(buffer, offset, length, position) {
		if (!this._opened) {
			throw new Error('GzipStream is not open');
		}

		const target = toWritableView(buffer);
		const targetOffset = normalizeSize(offset, 0);
		if (targetOffset < 0 || targetOffset > target.byteLength) {
			throw new Error('offset is out of range');
		}

		const maxLength = target.byteLength - targetOffset;
		const requestedLength = Math.min(normalizeSize(length, 0), maxLength);
		if (requestedLength <= 0) {
			return 0;
		}

		const requestedPosition = position == null
			? this._sequentialPosition
			: normalizeSize(position, 0);

		if (requestedPosition < 0) {
			throw new Error('position is out of range');
		}

		let totalRead = 0;
		let writeOffset = targetOffset;
		let currentPosition = requestedPosition;

		if (currentPosition < this._prefixCache.byteLength) {
			const availableInPrefix = this._prefixCache.byteLength - currentPosition;
			const copyLength = Math.min(requestedLength, availableInPrefix);
			target.set(
				this._prefixCache.subarray(currentPosition, currentPosition + copyLength),
				writeOffset
			);
			totalRead += copyLength;
			writeOffset += copyLength;
			currentPosition += copyLength;
		}

		const remaining = requestedLength - totalRead;
		if (remaining <= 0) {
			return totalRead;
		}

		if (currentPosition !== this._sequentialPosition) {
			const atKnownEof = this._ended && this._queueLength === 0 && currentPosition >= this._sequentialPosition;
			if (!atKnownEof) {
				throw new Error('Gzip stream is non-seekable; reads beyond cached prefix must be sequential');
			}
			return totalRead;
		}

		this._ensureQueueBytes(remaining);
		const copiedFromQueue = this._consumeQueue(target, writeOffset, remaining);
		this._sequentialPosition += copiedFromQueue;
		totalRead += copiedFromQueue;

		return totalRead;
	}

	_createInflater(onData) {
		if (this.createInflater) {
			const customInflater = this.createInflater({
				runtime: this._runtime,
				source: this.source,
				compressedSize,
				uncompressedSize,
				onData,
			});
			if (!customInflater || typeof customInflater.push !== 'function') {
				throw new Error('createInflater() must return an object with push(chunk, isLast)');
			}
			return customInflater;
		}

		return createPakoInflater(this._runtime, onData);
	}

	_prefetchPrefix() {
		if (this.prefixCacheSize <= 0) {
			this._prefixCache = new Uint8Array(0);
			return;
		}

		const chunks = [];
		let totalLength = 0;

		while (totalLength < this.prefixCacheSize) {
			if (this._queueLength === 0) {
				if (this._ended) {
					break;
				}
				this._pumpCompressedChunk();
				continue;
			}

			const remaining = this.prefixCacheSize - totalLength;
			const tmp = new Uint8Array(Math.min(remaining, this._queueLength));
			const copied = this._consumeQueue(tmp, 0, tmp.byteLength);
			if (copied <= 0) {
				break;
			}

			chunks.push(copied === tmp.byteLength ? tmp : tmp.subarray(0, copied));
			totalLength += copied;
		}

		this._prefixCache = concatChunks(chunks, totalLength);
	}

	_ensureQueueBytes(minimum) {
		while (this._queueLength < minimum && !this._ended) {
			this._pumpCompressedChunk();
		}
	}

	_pumpCompressedChunk() {
		if (this._ended || !this._sourceReader || !this._inflater) {
			return;
		}

		const chunk = this._sourceReader.readChunk();
		if (!chunk || chunk.byteLength === 0) {
			this._inflater.push(new Uint8Array(0), true);
			this._ended = true;
			return;
		}

		const isLast = this._sourceReader.eof;
		this._inflater.push(chunk, isLast);
		if (isLast) {
			this._ended = true;
		}
	}

	_enqueue(chunk) {
		if (!chunk || chunk.byteLength === 0) {
			return;
		}
		this._queue.push(chunk);
		this._queueLength += chunk.byteLength;
	}

	_consumeQueue(target, offset, length) {
		let remaining = length;
		let writeOffset = offset;
		let totalCopied = 0;

		while (remaining > 0 && this._queue.length > 0) {
			const current = this._queue[0];
			const copyLength = Math.min(remaining, current.byteLength);

			target.set(current.subarray(0, copyLength), writeOffset);

			totalCopied += copyLength;
			writeOffset += copyLength;
			remaining -= copyLength;
			this._queueLength -= copyLength;

			if (copyLength === current.byteLength) {
				this._queue.shift();
			} else {
				this._queue[0] = current.subarray(copyLength);
			}
		}

		return totalCopied;
	}

	_resetReadState() {
		this._prefixCache = new Uint8Array(0);
		this._sequentialPosition = 0;
		this._queue = [];
		this._queueLength = 0;
		this._ended = false;
	}

	_teardown() {
		if (this._inflater && typeof this._inflater.close === 'function') {
			try {
				this._inflater.close();
			} catch (_error) {
			}
		}

		if (this._sourceReader && typeof this._sourceReader.close === 'function') {
			try {
				this._sourceReader.close();
			} catch (_error) {
			}
		}

		this._sourceReader = null;
		this._inflater = null;
		this._runtime = null;
		this._resetReadState();
	}
}

export default GzipStream;
