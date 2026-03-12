/**
 * RKFW 解析结果类型定义。
 *
 * 该文件仅存放 JSDoc typedef，供 JS/TS 场景下的类型标注与文档说明使用。
 */

/**
 * @typedef {object} RkfwLoaderInfo
 * @property {string} name - 固定为 MiniLoaderAll.bin。
 * @property {number} offset - loader 在源 Blob 中的绝对偏移。
 * @property {number} size - loader 大小（字节）。
 */

/**
 * @typedef {object} RkfwPartInfo
 * @property {string} name - 分区名（RKAF entry name）。
 * @property {string | null} fileName - 分区文件名（RKAF entry filename）。
 * @property {number} offset - 分区数据在源 Blob 中的绝对偏移。
 * @property {number} size - 分区大小（字节，已过滤 0）。
 * @property {number | null} flashSector - 分区 flash 偏移扇区（512字节）；0xFFFFFFFF 归一化为 null。
 */

/**
 * @typedef {object} RkfwInfo
 * @property {RkfwLoaderInfo} loader - Loader 信息。
 * @property {RkfwPartInfo[]} parts - 分区列表。
 * @property {string} model - 机型字段（RKAF model）。
 * @property {string} manufacturer - 厂商字段（RKAF manufacturer）。
 */

export {};
