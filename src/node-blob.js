import fs from 'node:fs';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';

export class NodeBlob {
	constructor(source, offset = 0, length) {
		if (typeof source === 'string') {
			const fd = fs.openSync(source, 'r');
			const stat = fs.fstatSync(fd);
			const lastModified = normalizeTimestamp(stat.mtimeMs);

			this.name = path.basename(source);
			this.lastModified = lastModified;
			this.lastModifiedDate = new Date(lastModified);
			this.type = '';

			this._private = {
				filePath: source,
				fd,
				offset: 0,
				length: Number(stat.size),
				ownsFd: true,
			};
			return;
		}

		if (!(source instanceof NodeBlob)) {
			throw new TypeError('NodeBlob constructor expects a file path or a NodeBlob instance.');
		}

		const parentState = source._private;
		const parent = source;
		const relativeOffset = toSafeInteger(offset, 'offset');
		const clampedRelativeOffset = Math.max(0, relativeOffset);
		const maxLength = Math.max(0, parentState.length - clampedRelativeOffset);
		const resolvedLength =
			length === undefined ? maxLength : Math.min(maxLength, Math.max(0, toSafeInteger(length, 'length')));

		this.name = parent.name;
		this.lastModified = parent.lastModified;
		this.lastModifiedDate = parent.lastModifiedDate;
		this.type = '';

		this._private = {
			filePath: parentState.filePath,
			fd: parentState.fd,
			offset: parentState.offset + clampedRelativeOffset,
			length: resolvedLength,
			ownsFd: false,
		};
	}

	get size() {
		return this._private.length;
	}

	async arrayBuffer() {
		return readNodeBlobAsArrayBuffer(this);
	}

	async bytes() {
		return new Uint8Array(await this.arrayBuffer());
	}

	async text() {
		return new TextDecoder().decode(await this.arrayBuffer());
	}

	stream() {
		const state = this._private;

		if (state.fd === undefined) {
			throw new Error('NodeBlob file descriptor is closed.');
		}

		const chunkSize = 64 * 1024;
		let bytesReadTotal = 0;

		return new ReadableStream({
			async pull(controller) {
				if (bytesReadTotal >= state.length) {
					controller.close();
					return;
				}

				const bytesToRead = Math.min(chunkSize, state.length - bytesReadTotal);
				const chunk = Buffer.alloc(bytesToRead);
				const bytesRead = await readFromFdAsync(
					state.fd,
					chunk,
					0,
					bytesToRead,
					state.offset + bytesReadTotal,
				);

				if (bytesRead === 0) {
					controller.close();
					return;
				}

				bytesReadTotal += bytesRead;
				controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, bytesRead));
			},
		});
	}

	get [Symbol.toStringTag]() {
		return 'Blob';
	}

	slice(start = 0, end = this.size, contentType = '') {
		const normalizedStart = normalizeSliceIndex(start, this.size);
		const normalizedEnd = normalizeSliceIndex(end, this.size);
		const finalEnd = Math.max(normalizedStart, normalizedEnd);
		const slicedBlob = new NodeBlob(this, normalizedStart, finalEnd - normalizedStart);
		slicedBlob.type = normalizeBlobType(contentType);
		return slicedBlob;
	}

	close() {
		const state = this._private;

		if (state.ownsFd && state.fd !== undefined) {
			fs.closeSync(state.fd);
			state.fd = undefined;
		}
	}
}

export class NodeBlobReaderSync {
	readAsArrayBuffer(nodeBlob) {
		if (!(nodeBlob instanceof NodeBlob)) {
			throw new TypeError('readAsArrayBuffer expects a NodeBlob instance.');
		}

		const state = nodeBlob._private;

		if (state.fd === undefined) {
			throw new Error('NodeBlob file descriptor is closed.');
		}

		const targetLength = state.length;
		const buffer = Buffer.alloc(targetLength);
		let bytesReadTotal = 0;

		while (bytesReadTotal < targetLength) {
			const bytesRead = fs.readSync(
				state.fd,
				buffer,
				bytesReadTotal,
				targetLength - bytesReadTotal,
				state.offset + bytesReadTotal,
			);

			if (bytesRead === 0) {
				break;
			}

			bytesReadTotal += bytesRead;
		}

		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesReadTotal);
	}
}

async function readNodeBlobAsArrayBuffer(nodeBlob) {
	if (!(nodeBlob instanceof NodeBlob)) {
		throw new TypeError('arrayBuffer expects a NodeBlob instance.');
	}

	const state = nodeBlob._private;

	if (state.fd === undefined) {
		throw new Error('NodeBlob file descriptor is closed.');
	}

	const targetLength = state.length;
	const buffer = Buffer.alloc(targetLength);
	let bytesReadTotal = 0;

	while (bytesReadTotal < targetLength) {
		const bytesRead = await readFromFdAsync(
			state.fd,
			buffer,
			bytesReadTotal,
			targetLength - bytesReadTotal,
			state.offset + bytesReadTotal,
		);

		if (bytesRead === 0) {
			break;
		}

		bytesReadTotal += bytesRead;
	}

	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesReadTotal);
}

function readFromFdAsync(fd, buffer, offset, length, position) {
	return new Promise((resolve, reject) => {
		fs.read(fd, buffer, offset, length, position, (error, bytesRead) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(bytesRead);
		});
	});
}

function normalizeSliceIndex(index, size) {
	const value = toSafeInteger(index, 'index');
	if (value < 0) {
		return Math.max(size + value, 0);
	}
	return Math.min(value, size);
}

function toSafeInteger(value, name) {
	if (!Number.isFinite(value)) {
		throw new TypeError(`${name} must be a finite number.`);
	}
	return Math.trunc(value);
}

function normalizeBlobType(value) {
	const type = String(value ?? '');
	if (/[^\u0020-\u007E]/.test(type)) {
		return '';
	}
	return type.toLowerCase();
}

function normalizeTimestamp(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return Date.now();
	}
	return Math.max(0, Math.trunc(parsed));
}
