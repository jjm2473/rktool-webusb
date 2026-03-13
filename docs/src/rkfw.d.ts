/**
 * RKFW 解析结果类型定义。
 */

interface RkfwLoaderInfo {
	name: string;
	offset: number;
	size: number;
}

interface RkfwPartInfo {
	name: string;
	fileName: string | null;
	offset: number;
	size: number;
	flashSector: number | null;
}

export interface RkfwInfo {
	loader: RkfwLoaderInfo;
	parts: RkfwPartInfo[];
	model: string;
	manufacturer: string;
}

export {};
