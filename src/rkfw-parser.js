const RKFW_HEADER_SIZE = 0x66;
const RKAF_HEADER_SIZE = 0x800;
const RKAF_PARTS_MAX = 16;
const RKAF_PARTS_BASE = 0x8c;
const RKAF_PART_SIZE = 0x70;
const INVALID_NAND_ADDR = 0xffffffff;

function assertBlobLike(blob) {
if (!blob || typeof blob !== 'object' || typeof blob.slice !== 'function') {
	throw new Error('blob must be a Blob-like object with slice()');
}
}

function normalizeSize(value, fieldName) {
const parsed = Number(value);
if (!Number.isFinite(parsed) || parsed < 0) {
	throw new Error(`${fieldName} must be a non-negative finite number`);
}
return Math.trunc(parsed);
}

function ensureRange(totalSize, offset, size, label) {
const safeOffset = normalizeSize(offset, `${label}.offset`);
const safeSize = normalizeSize(size, `${label}.size`);
if (safeOffset > totalSize || safeOffset + safeSize > totalSize) {
	throw new Error(`${label} is out of blob bounds`);
}
}

async function readBlobRange(blob, offset, size, label) {
const totalSize = normalizeSize(blob.size, 'blob.size');
ensureRange(totalSize, offset, size, label);
if (size === 0) {
	return new Uint8Array(0);
}

const sliced = blob.slice(offset, offset + size);
if (!sliced || typeof sliced.arrayBuffer !== 'function') {
	throw new Error('blob.slice() must return a Blob-like object with arrayBuffer()');
}

const arrayBuffer = await sliced.arrayBuffer();
if (!arrayBuffer || arrayBuffer.byteLength !== size) {
	throw new Error(`Failed to read ${label}`);
}
return new Uint8Array(arrayBuffer);
}

function readLe32(bytes, offset, fieldName) {
if (offset < 0 || offset + 4 > bytes.byteLength) {
	throw new Error(`${fieldName} is outside of header range`);
}
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
return view.getUint32(offset, true);
}

function readMagic(bytes, offset) {
if (offset < 0 || offset + 4 > bytes.byteLength) {
	return '';
}
return String.fromCharCode(
	bytes[offset],
	bytes[offset + 1],
	bytes[offset + 2],
	bytes[offset + 3],
);
}

const CSTRING_DECODER = new TextDecoder();

function readCString(bytes) {
let end = bytes.byteLength;
for (let index = 0; index < bytes.byteLength; index++) {
	if (bytes[index] === 0) {
	end = index;
	break;
	}
}
return CSTRING_DECODER.decode(bytes.subarray(0, end)).trim();
}

export async function isRkfwBlob(blob) {
try {
	const header = await readBlobRange(blob, 0, RKFW_HEADER_SIZE, 'RKFW header');
	const magic = readMagic(header, 0);
	return magic === 'RKFW';
} catch (error) {
	return false;
}
}

/**
 * Parse RKFW/RKAF layout metadata from a Blob-like source.
 *
 * @param {Blob} blob
 * @returns {Promise<RkfwInfo>}
 */
export async function parseRkfwBlob(blob) {
assertBlobLike(blob);
const blobSize = normalizeSize(blob.size, 'blob.size');

const rkfw = await readBlobRange(blob, 0, RKFW_HEADER_SIZE, 'RKFW header');
const rkfwMagic = readMagic(rkfw, 0);
if (rkfwMagic !== 'RKFW') {
	throw new Error(`Not an RKFW blob (magic: ${JSON.stringify(rkfwMagic)})`);
}

const loaderOffset = readLe32(rkfw, 0x19, 'rkfw.loader_offset');
const loaderSize = readLe32(rkfw, 0x1d, 'rkfw.loader_length');
const imageOffset = readLe32(rkfw, 0x21, 'rkfw.image_offset');
const imageSize = readLe32(rkfw, 0x25, 'rkfw.image_length');

ensureRange(blobSize, loaderOffset, loaderSize, 'loader');
ensureRange(blobSize, imageOffset, RKAF_HEADER_SIZE, 'RKAF header');
if (imageSize > 0) {
	ensureRange(blobSize, imageOffset, imageSize, 'RKAF image');
}

const rkaf = await readBlobRange(blob, imageOffset, RKAF_HEADER_SIZE, 'RKAF header');
const rkafMagic = readMagic(rkaf, 0);
if (rkafMagic !== 'RKAF') {
	throw new Error(`RKAF magic mismatch at offset ${imageOffset} (magic: ${JSON.stringify(rkafMagic)})`);
}

const model = readCString(rkaf.subarray(0x08, 0x08 + 0x22));
const manufacturer = readCString(rkaf.subarray(0x48, 0x48 + 0x38));
const numParts = Math.min(readLe32(rkaf, 0x88, 'rkaf.num_parts'), RKAF_PARTS_MAX);

const parts = [];
for (let index = 0; index < numParts; index++) {
	const entryOffset = RKAF_PARTS_BASE + index * RKAF_PART_SIZE;
	if (entryOffset + RKAF_PART_SIZE > rkaf.byteLength) {
	break;
	}

	const entry = rkaf.subarray(entryOffset, entryOffset + RKAF_PART_SIZE);
	const name = readCString(entry.subarray(0x00, 0x00 + 32));
	const fileName = readCString(entry.subarray(0x20, 0x20 + 60));
	const pos = readLe32(entry, 0x60, `rkaf.parts[${index}].pos`);
	const rawNandAddr = readLe32(entry, 0x64, `rkaf.parts[${index}].nand_addr`);
	const flashSector = rawNandAddr === INVALID_NAND_ADDR ? null : rawNandAddr;
	let size = readLe32(entry, 0x6c, `rkaf.parts[${index}].size`);

	if (!name || size === 0) {
	continue;
	}

	let offset = imageOffset + pos;
	ensureRange(blobSize, offset, size, `rkaf.parts[${index}]`);
	if (name === "parameter") {
		if (size < 8)
			throw new Error(`parameter partition too small for magic and size (size: ${size})`);
		const parm = await readBlobRange(blob, offset, 8, `rkaf.parameter.header`);
		const parmMagic = readMagic(parm, 0);
		if (parmMagic !== 'PARM') {
			throw new Error(`parameter partition magic mismatch (magic: ${JSON.stringify(parmMagic)})`);
		}
		const realSize = readLe32(parm, 4, 'rkaf.parameter.real_size');
		if (realSize === 0 || realSize > size - 12) {
			throw new Error(`parameter partition has invalid real size (realSize: ${realSize}, partitionSize: ${size})`);
		}
		offset = offset + 8;
		size = realSize;
	}

	parts.push({
	name,
	fileName: fileName || null,
	offset,
	size,
	flashSector,
	});
}

return {
	loader: {
	name: 'MiniLoaderAll.bin',
	offset: loaderOffset,
	size: loaderSize,
	flashSector: null,
	},
	parts,
	model,
	manufacturer,
};
}
