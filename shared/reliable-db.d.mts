export const businessNames: string[];
export function hex(value: number): string;
export function bytesHex(bytes: Uint8Array): string;
export function stateName(state: number): string;
export type ReliableRecord = { offset: number; raw: Uint8Array; issues: string[]; dbSeq?: number; state?: number; length?: number; type?: number; errcode?: number; seq?: number; serial?: number; time?: number; uniq?: string; body?: Uint8Array };
export function parseReliableDb(bytes: Uint8Array, slotSize?: number, littleEndian?: boolean): { records: ReliableRecord[]; empty: number; slots: number };

export function reliableDbSlotSize(name: string): number | undefined;

export function formatReliableDbTime(seconds?: number): string;
