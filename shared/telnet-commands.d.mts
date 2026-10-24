export function parseCommandGroups(text: string, newId: () => string): { id: string; name: string; commands: { id: string; name: string; text: string; color?: string }[] }[];
export function commandVariables(text: string): string[];
export function renderCommand(text: string, values: Record<string, string>): string;
export const commandButtonColors: readonly string[];
export function randomCommandColor(usedColors?: readonly string[]): string;
