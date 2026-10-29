import React, { createContext, useContext } from 'react';
import type { Profile } from './types';
export type TerminalSeed = { host: string; port: number; name: string; webMode: boolean; webAddress: string; webUser: string; webPassword: string; rememberPassword: boolean; device: string; deviceName: string; token: string };
export type SessionSeed = { kind: 'ssh'; profile: Profile } | { kind: 'telnet'; terminal: TerminalSeed } | { kind: 'log'; path: string };
export const SessionContext = createContext({ id: 'default', active: true, leftCollapsed: false, rightCollapsed: false, toggleLeft: () => {}, toggleRight: () => {}, tabBar: null as React.ReactNode, beforeConnect: (_seed: SessionSeed): boolean => false, title: (_title: string) => {} });
export function useSession() { return useContext(SessionContext); }
export function useViewer() {
  const { id } = useSession();
  return React.useMemo(() => new Proxy({} as Window['viewer'], { get(_target, key: keyof Window['viewer']) {
    const target = window.viewer;
    if (key === 'getPathForFile') return target.getPathForFile;
    if (key === 'onEvent') return (callback: Parameters<typeof target.onEvent>[0]) => target.onEvent(event => { if (!event.sessionId || event.sessionId === id) callback(event); });
    return (...args: unknown[]) => target.sessionInvoke(id, String(key), args);
  } }), [id]);
}
export const slotId = (id: string, name: string) => `${id}-${name}`;
