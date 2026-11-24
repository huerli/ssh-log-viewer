export function startCommandStream(options: {
  commands: (string | { text: string; interval: number })[]; interval?: number; repeat: boolean;
  send(command: string): Promise<void>;
  onProgress(count: number): void; onDone(): void; onError(error: unknown): void;
}): () => void;
