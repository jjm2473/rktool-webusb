import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeBlob, NodeBlobReaderSync } from '../../src/node-blob.js';

async function withTempFile(bytes, callback) {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rktool-nodeblob-'));
	const filePath = path.join(tempDir, 'payload.bin');
	await fs.writeFile(filePath, Buffer.from(bytes));

	try {
		return await callback(filePath);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function readStreamBytes(stream) {
	const reader = stream.getReader();
	const chunks = [];
	let totalLength = 0;

	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		totalLength += value.byteLength;
	}

	const output = new Uint8Array(totalLength);
	let writeOffset = 0;
	for (const chunk of chunks) {
		output.set(chunk, writeOffset);
		writeOffset += chunk.byteLength;
	}
	return output;
}

test('constructs from file path and reads full content with NodeBlobReaderSync', async () => {
	await withTempFile([1, 2, 3, 4, 5, 6], async (filePath) => {
		const stat = await fs.stat(filePath);
		const blob = new NodeBlob(filePath);
		const reader = new NodeBlobReaderSync();

		try {
			assert.equal(blob.name, path.basename(filePath));
			assert.equal(blob.lastModified, Math.trunc(stat.mtimeMs));
			assert.equal(blob.lastModifiedDate instanceof Date, true);
			assert.equal(blob.size, 6);
			assert.equal(blob.type, '');
			assert.equal(blob[Symbol.toStringTag], 'Blob');
			assert.equal('filePath' in blob, false);
			assert.equal('fd' in blob, false);
			assert.equal('offset' in blob, false);
			assert.equal('length' in blob, false);

			const output = Buffer.from(reader.readAsArrayBuffer(blob));
			assert.deepEqual(Array.from(output), [1, 2, 3, 4, 5, 6]);
		} finally {
			blob.close();
		}
	});
});

test('supports parent-based constructor and slice contentType normalization', async () => {
	await withTempFile(Buffer.from('abcdef'), async (filePath) => {
		const root = new NodeBlob(filePath);
		const reader = new NodeBlobReaderSync();

		try {
			const derived = new NodeBlob(root, 2, 3);
			assert.equal(derived.name, root.name);
			assert.equal(derived.lastModified, root.lastModified);
			assert.equal(derived.size, 3);
			assert.equal('filePath' in derived, false);
			assert.equal('fd' in derived, false);
			assert.equal('offset' in derived, false);
			assert.equal('length' in derived, false);

			const derivedText = Buffer.from(reader.readAsArrayBuffer(derived)).toString('utf8');
			assert.equal(derivedText, 'cde');

			const sliced = root.slice(-4, -1, 'Text/Plain;Charset=UTF-8');
			assert.equal(sliced.name, root.name);
			assert.equal(sliced.lastModified, root.lastModified);
			assert.equal(sliced.type, 'text/plain;charset=utf-8');
			assert.equal(Buffer.from(reader.readAsArrayBuffer(sliced)).toString('utf8'), 'cde');

			const invalidTypeSlice = root.slice(0, 1, 'bad\u0001type');
			assert.equal(invalidTypeSlice.type, '');
		} finally {
			root.close();
		}
	});
});

test('arrayBuffer, text, bytes and stream return consistent data', async () => {
	await withTempFile(Buffer.from('hello-world'), async (filePath) => {
		const blob = new NodeBlob(filePath);
		const slice = blob.slice(6, 11);

		try {
			const fromArrayBuffer = Buffer.from(await slice.arrayBuffer()).toString('utf8');
			const fromText = await slice.text();
			const fromBytes = Buffer.from(await slice.bytes()).toString('utf8');
			const fromStream = Buffer.from(await readStreamBytes(slice.stream())).toString('utf8');

			assert.equal(fromArrayBuffer, 'world');
			assert.equal(fromText, 'world');
			assert.equal(fromBytes, 'world');
			assert.equal(fromStream, 'world');
		} finally {
			blob.close();
		}
	});
});

test('read operations fail after owner blob is closed', async () => {
	await withTempFile([9, 8, 7], async (filePath) => {
		const blob = new NodeBlob(filePath);
		const reader = new NodeBlobReaderSync();

		blob.close();

		assert.throws(() => reader.readAsArrayBuffer(blob), /closed/);
		await assert.rejects(() => blob.arrayBuffer(), /closed/);
		assert.throws(() => blob.stream(), /closed/);
	});
});
