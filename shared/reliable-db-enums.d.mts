export type EnumDefinitions = Record<number, { name: string; description: string }>;
export const wholeRecordTypes: EnumDefinitions;
export const alarmTypes: EnumDefinitions;
export const transportTypes: EnumDefinitions;
export function enumDescription(definitions: EnumDefinitions, value: number): string;
export function recordTypeDescription(type?: number, body?: Uint8Array): string;
