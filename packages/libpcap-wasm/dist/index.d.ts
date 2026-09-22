export interface Packet { number: number; seconds: number; microseconds: number; capturedLength: number; originalLength: number; bytes: Uint8Array; bytesTruncated: boolean }
export interface CaptureResult { datalink?: number; datalinkName?: string; datalinkDescription?: string; offset?: number; packets?: Packet[]; nextOffset?: number | null; eof?: boolean; error?: string }
export interface Libpcap { inspectCapture(bytes: Uint8Array, filter: string, offset: number, limit: number, maxPacketBytes: number): CaptureResult }
export default function createLibpcap(options?: { locateFile?: (file: string) => string }): Promise<Libpcap>
