export type LogFont = { family: string; size: number };
export const defaultLogFont: LogFont;
export function validateLogFont(value: unknown): LogFont;
export function logLineHeight(size: number): number;
export function resultLineHeight(size: number): number;
export function logFontFamily(family: string): string;
