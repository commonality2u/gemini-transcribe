import type { TranscriptEntry } from '../types';

export const CHUNK_DURATION = 120; // 2 minutes in seconds
export const CHUNK_OVERLAP = 60; // 1 minute overlap

export function formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export function parseTimeToSeconds(timestamp: string): number {
    const [minutes, seconds] = timestamp.split(':').map(Number);
    return minutes * 60 + seconds;
}

export function mergeTranscripts(chunks: TranscriptEntry[][], chunkStartTimes: number[]): TranscriptEntry[] {
    const merged: TranscriptEntry[] = [];
    const speakerMap = new Map<string, string>();
    let currentSpeakerIndex = 1;

    // First, normalize all speaker names across chunks
    chunks.forEach(chunk => {
        chunk.forEach(entry => {
            if (!speakerMap.has(entry.speaker)) {
                speakerMap.set(entry.speaker, `Speaker ${currentSpeakerIndex++}`);
            }
        });
    });

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const currentChunkStartTime = chunkStartTimes[i];

        for (const entry of chunk) {
            const entryTime = parseTimeToSeconds(entry.timestamp);
            const adjustedTime = entryTime + currentChunkStartTime;

            // Only skip if we have this exact timestamp+speaker+text combination
            const isDuplicate = merged.some(existing => 
                Math.abs(parseTimeToSeconds(existing.timestamp) - adjustedTime) < 5 &&
                existing.speaker === speakerMap.get(entry.speaker) &&
                existing.text === entry.text
            );

            if (isDuplicate) continue;

            merged.push({
                ...entry,
                timestamp: formatTime(adjustedTime),
                speaker: speakerMap.get(entry.speaker) || entry.speaker
            });
        }
    }

    // Sort by timestamp after all adjustments
    return merged.sort((a, b) => parseTimeToSeconds(a.timestamp) - parseTimeToSeconds(b.timestamp));
} 