import {
	InternalCompressedStream,
	normalizeSize,
	toUint8Array,
} from './compressed-stream.js';

function isNodeRuntime() {
	return typeof process !== 'undefined' && !!(process.versions && process.versions.node);
}

let nodeRequire = null;
if (isNodeRuntime()) {
	const { createRequire } = await import('node:module');
	nodeRequire = createRequire(import.meta.url);
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

function resolvePakoModule(runtime) {
	if (runtime === 'node' && nodeRequire) {
		try {
			const pako = nodeRequire('pako');
			if (pako && typeof pako === 'object') {
				return pako;
			}
		} catch (_error) {
		}
	}

	if (globalThis.pako && typeof globalThis.pako === 'object') {
		return globalThis.pako;
	}

	return null;
}

function createGzipInflater({ runtime, onData }) {
	const pako = resolvePakoModule(runtime);
	const InflateCtor = typeof pako?.Inflate === 'function' ? pako.Inflate : null;
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

function probeGzipUncompressedSize(context) {
	const compressedSize = normalizeSize(context?.compressedSize, 0);
	const readRange = context?.readRange;
	if (compressedSize < 4 || typeof readRange !== 'function') {
		return null;
	}

	const trailer = readRange(compressedSize - 4, 4);
	return readUint32LE(trailer, 0);
}

export class GzipStream extends InternalCompressedStream {
	static formatName = 'gzip';
	static formatDisplayName = 'gzip';
	static streamLabel = 'GzipStream';

	probeUncompressedSize(context) {
		return probeGzipUncompressedSize(context);
	}

	createInflater(context) {
		return createGzipInflater(context);
	}
}
