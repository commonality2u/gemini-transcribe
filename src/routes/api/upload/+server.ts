import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { writeFile, readFile, unlink } from 'fs/promises';
import { file as tempFile } from 'tmp-promise';
import type { FileResult } from 'tmp-promise';
import { env } from '$env/dynamic/private';
import { safetySettings as defaultSafetySettings } from '$lib/index';
import type { RequestEvent } from '@sveltejs/kit';
import ffmpeg from 'fluent-ffmpeg';
import { join } from 'path';
import { tmpdir } from 'os';
import { CHUNK_DURATION, CHUNK_OVERLAP, formatTime, parseTimeToSeconds, mergeTranscripts } from '$lib/utils/audio';
import type { TranscriptEntry } from '$lib/types';

async function getAudioDuration(filePath: string): Promise<number> {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) reject(err);
			else resolve(metadata.format.duration || 0);
		});
	});
}

async function processChunk(
	fileManager: GoogleAIFileManager,
	model: any,
	inputPath: string,
	mimeType: string,
	startTime: number,
	chunkDuration: number
): Promise<TranscriptEntry[]> {
	let chunkFileHandle: FileResult | undefined;

	try {
		console.log(`[processChunk] Starting processing for chunk at ${formatTime(startTime)}`);

		// Create temporary file for the chunk using tmp-promise
		console.log(`[processChunk] Creating temporary file for chunk at ${formatTime(startTime)}`);
		chunkFileHandle = await tempFile({ postfix: `.${inputPath.split('.').pop()}` });
		if (!chunkFileHandle) {
			throw new Error('Failed to create temporary file for chunk');
		}
		console.log(`[processChunk] Temporary file created for chunk at ${formatTime(startTime)}: ${chunkFileHandle.path}`);

		// Extract chunk using ffmpeg
		console.log(`[processChunk] Starting FFmpeg extraction for chunk at ${formatTime(startTime)}`);
		await new Promise<void>((resolve, reject) => {
			ffmpeg(inputPath)
				.setStartTime(startTime)
				.setDuration(chunkDuration)
				.output(chunkFileHandle!.path)
				.on('end', () => resolve())
				.on('error', (err) => {
					console.error(`[processChunk] FFmpeg error for chunk at ${formatTime(startTime)}:`, err);
					reject(err);
				})
				.run();
		});
		console.log(`[processChunk] FFmpeg extraction complete for chunk at ${formatTime(startTime)}`);

		// Upload chunk
		console.log(`[processChunk] Uploading chunk at ${formatTime(startTime)}`);
		const uploadResult = await fileManager.uploadFile(chunkFileHandle.path, { mimeType });
		console.log(`[processChunk] Uploaded chunk at ${formatTime(startTime)}. File name: ${uploadResult.file.name}`);
		let uploadedFile = await fileManager.getFile(uploadResult.file.name);

		while (uploadedFile.state === FileState.PROCESSING) {
			console.log(`[processChunk] Chunk at ${formatTime(startTime)} is processing. State: ${uploadedFile.state}`);
			await new Promise((resolve) => setTimeout(resolve, 5000));
			uploadedFile = await fileManager.getFile(uploadResult.file.name);
		}

		if (uploadedFile.state === FileState.FAILED) {
			throw new Error('Chunk processing failed');
		}
		console.log(`[processChunk] Chunk at ${formatTime(startTime)} processing complete. Final state: ${uploadedFile.state}`);

		// Generate transcript
		console.log(`[processChunk] Generating transcript for chunk at ${formatTime(startTime)}`);
		const result = await model.generateContentStream([
			{
				fileData: {
					mimeType,
					fileUri: uploadResult.file.uri
				}
			},
			{
				text: `Generate a transcript for this audio segment. Always use the format mm:ss for the time. Group similar text together rather than time-stamping every line. Maintain consistent speaker labels. Respond with the transcript in the form of this JSON schema:
     [{"timestamp": "00:00", "speaker": "Speaker 1", "text": "Today I will be talking about the importance of AI in the modern world."},{"timestamp": "01:00", "speaker": "Speaker 1", "text": "Has AI has revolutionized the way we live and work?"}]`
			}
		]);

		let transcriptText = '';
		for await (const chunk of result.stream) {
			transcriptText += typeof chunk === 'string' ? chunk : await chunk.text();
		}
		const parsedTranscript = JSON.parse(transcriptText);
		console.log(`[processChunk] Chunk at ${formatTime(startTime)} processed successfully`);
		return parsedTranscript.map((entry: TranscriptEntry) => {
			const entryTime = parseTimeToSeconds(entry.timestamp);
			const adjustedTime = Math.min(entryTime + startTime, startTime + chunkDuration);
			return {
				...entry,
				timestamp: formatTime(adjustedTime)
			};
		});
	} catch (error: any) {
		console.error(`[processChunk] Error processing chunk at ${formatTime(startTime)}:`, error);
		if (error.message?.includes('SAFETY') || error.message?.includes('429')) {
			const message = error.message?.includes('SAFETY') 
				? 'This segment was skipped due to content safety filters. The transcription will continue with the next segment.'
				: 'Rate limit reached. Waiting before retrying.';
			
			return [{
				timestamp: formatTime(startTime),
				speaker: 'System',
				text: message
			}];
		}
		throw error; // Only re-throw other types of errors
	} finally {
		if (chunkFileHandle) {
			await chunkFileHandle.cleanup();
		}
		console.log(`[processChunk] Cleaned up temporary file for chunk at ${formatTime(startTime)}`);
	}
}

export async function POST({ request }: RequestEvent) {
	const formData = await request.formData();
	const file = formData.get('file') as File;
	const startTime = formData.get('startTime');
	const lastTimestamp = formData.get('lastTimestamp');

	if (!file) {
		return new Response('No file provided', { status: 400 });
	}

	let tempFileHandle: FileResult | undefined;
	const chunks: TranscriptEntry[][] = [];
	const chunkStartTimes: number[] = [];
	const encoder = new TextEncoder();

	try {
		console.log('Creating temporary file for input');
		tempFileHandle = await tempFile({ postfix: `.${file.name.split('.').pop()}` });
		if (!tempFileHandle) {
			throw new Error('Failed to create temporary file for input');
		}
		const arrayBuffer = await file.arrayBuffer();
		await writeFile(tempFileHandle.path, new Uint8Array(arrayBuffer));

		console.log('Getting audio duration');
		const duration = await getAudioDuration(tempFileHandle.path);
		console.log(`Total audio duration: ${formatTime(duration)}`);
		const initialStartTime = startTime ? parseInt(startTime as string, 10) : 0;

		// Set up streaming response
		const stream = new ReadableStream({
			async start(controller) {
				try {
					const fileManager = new GoogleAIFileManager(env.GOOGLE_API_KEY);
					const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
					const model = genAI.getGenerativeModel({
						model: 'gemini-2.0-flash-exp',
						safetySettings: [
							{
								category: HarmCategory.HARM_CATEGORY_HARASSMENT,
								threshold: HarmBlockThreshold.BLOCK_NONE,
							},
							{
								category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
								threshold: HarmBlockThreshold.BLOCK_NONE,
							},
							{
								category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
								threshold: HarmBlockThreshold.BLOCK_NONE,
							},
							{
								category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
								threshold: HarmBlockThreshold.BLOCK_NONE,
							}
						],
						generationConfig: { responseMimeType: 'application/json' }
					});

					// Process audio in chunks
					for (let time = initialStartTime; time < duration; time += CHUNK_DURATION) {
						const chunkStartTime = Math.max(0, time - CHUNK_OVERLAP);
						const chunkDuration = Math.min(CHUNK_DURATION + CHUNK_OVERLAP, duration - chunkStartTime);

						console.log(`Processing chunk from ${formatTime(chunkStartTime)} to ${formatTime(chunkStartTime + chunkDuration)}`);

						try {
							const chunkTranscript = await processChunk(
								fileManager,
								model,
								tempFileHandle!.path,
								file.type,
								chunkStartTime,
								chunkDuration
							);
							
							chunks.push(chunkTranscript);
							chunkStartTimes.push(chunkStartTime);

							// Send chunk with metadata to help client handle overlaps
							const chunkData = {
								startTime: chunkStartTime,
								endTime: chunkStartTime + chunkDuration,
								totalDuration: duration,
								processedTimestamp: formatTime(Date.now() / 1000),
								status: chunkTranscript[0]?.speaker === 'System' ? 'error' : 'success',
								retryCount: 0,
								entries: chunkTranscript
							};
							console.log(`Processed chunk ${formatTime(chunkStartTime)} to ${formatTime(chunkStartTime + chunkDuration)}`);
							const jsonString = JSON.stringify(chunkData);
							controller.enqueue(new TextEncoder().encode(jsonString + '\n'));

							// Add delay between chunks based on previous chunk status
							const delayTime = chunkTranscript[0]?.speaker === 'System' ? 10000 : 3000;
							await new Promise((resolve) => setTimeout(resolve, delayTime));

						} catch (error: any) {
							console.error(`Error processing chunk at ${formatTime(chunkStartTime)}:`, error);
							// Handle rate limiting and other errors
							const isRateLimit = error.message?.includes('429') || error.message?.includes('Too Many Requests');
							const errorDelay = isRateLimit ? 15000 : 5000;

							const errorData = {
								startTime: chunkStartTime,
								endTime: chunkStartTime + chunkDuration,
								totalDuration: duration,
								status: 'error',
								processedTimestamp: formatTime(Date.now() / 1000),
								retryCount: 0,
								retryAfter: errorDelay,
								entries: [{
									timestamp: formatTime(chunkStartTime),
									speaker: "System",
									text: isRateLimit 
										? "Rate limit reached. Waiting before continuing."
										: "Error processing segment. Will retry shortly."
								}]
							};
							controller.enqueue(encoder.encode(JSON.stringify(errorData) + '\n'));
							
							// Wait before continuing
							await new Promise(resolve => setTimeout(resolve, errorDelay));
						}
					}

					controller.close();
				} catch (error) {
					controller.error(error);
				}
				// Clean up the temporary file after all chunks are processed
				finally {
					if (tempFileHandle) {
						await tempFileHandle.cleanup();
					}
				}
			},
		});

		return new Response(stream, {
			headers: {
				'Content-Type': 'application/json',
				'Transfer-Encoding': 'chunked'
			}
		});
	} catch (error) {
		console.error('Error processing file:', error);
		return new Response('Error processing file', { status: 500 });
	}
}
