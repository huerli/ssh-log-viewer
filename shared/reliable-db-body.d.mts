export type BodyField = { section: string; key: string; label: string; offset: number; size: number; value: string | number; description?: string };
export function decodeReliableBody(type: number | undefined, bytes: Uint8Array | undefined, littleEndian?: boolean, portable?: boolean): { fields: BodyField[]; error?: string; remaining?: Uint8Array };
export function describeReliableTail(bytes?: Uint8Array, littleEndian?: boolean): { firstValue?: number; text: string; encoding: string } | undefined;
