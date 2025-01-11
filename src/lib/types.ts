export interface TranscriptEntry { timestamp: string; speaker: string; text: string; }

export interface ChunkMetadata {
    startTime: number;
    endTime: number;
    processedTimestamp: string;
    status: 'success' | 'error';
    retryCount?: number;
    entries: TranscriptEntry[];
}
