<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { formatTime, parseTimeToSeconds } from '$lib/utils/audio';
	import type { TranscriptEntry } from '$lib/types';

	let selectedFile: File | null = null;
	let uploadComplete = false;
	let isUploading = false;
	let fileUrl: string | null = null;
	let fileType: 'audio' | 'video';
	let processedDuration = 0;
	let lastProcessedTimestamp = '00:00';
	let transcriptionInterrupted = false;
	let duration = 0;  // Total audio duration

	let streamBuffer = '';
	let transcriptArray: TranscriptEntry[] = [];

	let audioElement: HTMLAudioElement | null = null;
	let videoElement: HTMLVideoElement | null = null;

	let processedChunks: { start: number; end: number }[] = [];

	function getSecondsFromTimestamp(timestamp: string): number {
		const [minutes, seconds] = timestamp.split(':').map(Number);
		return minutes * 60 + seconds;
	}

	function updateProcessedDuration(timestamp: string) {
		const seconds = getSecondsFromTimestamp(timestamp);
		if (seconds > processedDuration) {
			processedDuration = seconds;
			lastProcessedTimestamp = timestamp;
		}
	}

	$: if (streamBuffer) {
		window.scrollTo({
			top: document.body.scrollHeight + 50,
			behavior: 'smooth'
		});
	}

	$: if (transcriptArray.length) {
		window.scrollTo(0, 0);
	}

	function handleTimestampClick(timestamp: string) {
		const [minutes, seconds] = timestamp.split(':').map(Number);
		const timeInSeconds = minutes * 60 + seconds;

		if (audioElement) {
			audioElement.currentTime = timeInSeconds;
			audioElement.play();
		}

		if (videoElement) {
			videoElement.currentTime = timeInSeconds;
			videoElement.play();
		}
	}

	function handleFileInput(event: Event) {
		const target = event.target as HTMLInputElement;
		selectedFile = target.files?.[0] ?? null;
		if (selectedFile) {
			fileUrl = URL.createObjectURL(selectedFile);
			fileType = selectedFile.type.includes('audio') ? 'audio' : 'video';
		}
	}

	async function handleSubmit(continuation: boolean = false, startFrom?: number) {
		isUploading = true;
		streamBuffer = '';
		let retryCount = 0;
		if (!continuation) {
			transcriptArray = [];
			processedChunks = [];
		}

		try {
			const formData = new FormData();
			if (!selectedFile) return;
			formData.append('file', selectedFile);
			formData.append('startTime', (startFrom ?? processedDuration).toString());
			if (continuation) {
				formData.append('retryCount', (++retryCount).toString());
			}

			const response = await fetch('/api/upload', {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				console.error(`Server error: ${response.status}`);
				transcriptionInterrupted = true;
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					// ... (parsing logic) ...
					uploadComplete = true;
					isUploading = false;
					break;
				}

				const textChunk = decoder.decode(value, { stream: true });
				streamBuffer += textChunk;

				const chunks = streamBuffer.split('\n');
				streamBuffer = chunks.pop() || '';

				// Update duration from first chunk metadata
				if (!duration && chunks.length > 0) {
					try {
						const firstChunk = JSON.parse(chunks[0]);
						if (firstChunk.totalDuration) {
							duration = firstChunk.totalDuration;
						}
					} catch (e) {
						console.warn('Could not parse duration from first chunk');
					}
				}

				for (const chunk of chunks) {
					const trimmedChunk = chunk.trim();
					if (!trimmedChunk) continue;
					try {
						const chunkTranscript = JSON.parse(trimmedChunk);
						// Handle chunk metadata
						if (chunkTranscript.status === 'error') {
							console.warn(`Error in chunk from ${formatTime(chunkTranscript.startTime)} to ${formatTime(chunkTranscript.endTime)}`);
							const isRateLimit = chunkTranscript.entries[0]?.text.includes('Rate limit');
							
							// Update UI to show error status
							transcriptionInterrupted = true;
							lastProcessedTimestamp = formatTime(chunkTranscript.startTime);
							
							// Wait before retrying
							const retryDelay = isRateLimit ? 15000 : 5000;
							await new Promise((resolve) => setTimeout(resolve, retryDelay));
							
							// Retry from the failed chunk
							handleSubmit(true, chunkTranscript.startTime);
							return;
						}

						if (chunkTranscript.entries) {
							// Track chunk boundaries
							processedChunks.push({
								start: chunkTranscript.startTime,
								end: chunkTranscript.endTime
							});
							checkForGaps();

							// Update UI immediately when we get new entries
							if (chunkTranscript.entries.length > 0) {
								const newEntries = chunkTranscript.entries.filter(entry => {
									const entryTime = getSecondsFromTimestamp(entry.timestamp);
									// Validate timestamp is within total duration
									if (entryTime > duration) {
										console.warn(`Invalid timestamp detected: ${entry.timestamp}`);
										return false;
									}
									return !transcriptArray.some(existing => 
										Math.abs(getSecondsFromTimestamp(existing.timestamp) - entryTime) < 2 &&
										existing.speaker === entry.speaker &&
										existing.text === entry.text
									);
								});

								if (newEntries.length > 0) {
									transcriptArray = [...transcriptArray, ...newEntries].sort((a, b) => 
										getSecondsFromTimestamp(a.timestamp) - getSecondsFromTimestamp(b.timestamp)
									);
									// Update processed duration
									const lastEntry = newEntries[newEntries.length - 1];
									updateProcessedDuration(lastEntry.timestamp);
								}
							}
						}
					} catch (error) {
						console.error('Error parsing chunk:', trimmedChunk, error);
					}
				}
			}
		} catch (error) {
			console.error("Streaming error:", error);
			transcriptionInterrupted = true;
		} finally {
			isUploading = false;
		}
	}

	async function downloadTranscript() {
		const response = await fetch('/api/download', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: transcriptArray })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcript.txt';
		a.click();
	}

	async function useSample() {
		const sampleFile = await fetch('/gettysburg-address.mp3');
		const blob = await sampleFile.blob();
		selectedFile = new File([blob], 'sample.mp3', { type: 'audio/mp3' });
		fileUrl = URL.createObjectURL(selectedFile);
		fileType = 'audio';
		handleSubmit();
	}

	function checkForGaps() {
		if (processedChunks.length < 2) return;
		
		processedChunks.sort((a, b) => a.start - b.start);
		
		for (let i = 1; i < processedChunks.length; i++) {
			const gap = processedChunks[i].start - processedChunks[i-1].end;
			if (gap > 5) { // 5 second tolerance
				console.warn(`Gap detected between ${formatTime(processedChunks[i-1].end)} and ${formatTime(processedChunks[i].start)}`);
				transcriptionInterrupted = true;
				lastProcessedTimestamp = formatTime(processedChunks[i-1].end);
				processedDuration = processedChunks[i-1].end;
			}
		}
	}

	// Add reactive statement to monitor chunk processing
	$: if (processedChunks.length > 0) {
		const lastChunk = processedChunks[processedChunks.length - 1];
		console.log(`Processing chunk: ${formatTime(lastChunk.start)} to ${formatTime(lastChunk.end)}`);
	}
</script>

<svelte:head>
	<title>Gemini Transcribe</title>
</svelte:head>

<main class="container mx-auto px-4 py-8">
	<section class="mb-12 text-center">
		<h1 class="mb-4 text-4xl font-bold text-blue-600">Gemini Transcribe</h1>
		<p class="text-xl text-gray-600">
			Transcribe audio and video files with speaker diarization and logically grouped timestamps.
		</p>
	</section>

	<div class="mx-auto max-w-2xl">
		{#if uploadComplete || transcriptionInterrupted}
			<div class="mb-6">
				{#if fileType === 'audio'}
					<audio src={fileUrl} controls class="mx-auto w-full" bind:this={audioElement} />
				{:else if fileType === 'video'}
					<video src={fileUrl} controls class="mx-auto w-full" bind:this={videoElement}>
						<track kind="captions" label="English" srclang="en" src={transcriptArray.length > 0 ? URL.createObjectURL(new Blob([JSON.stringify(transcriptArray)], { type: 'text/vtt' })) : ''} />
					</video>
				{/if}
			</div>

			{#if transcriptionInterrupted}
				<div class="mb-4 rounded-lg bg-yellow-50 p-4">
					<p class="text-yellow-800">
						The transcription was interrupted at {lastProcessedTimestamp}. Would you like to continue from this point?
					</p>
					<button
						on:click={() => handleSubmit(true)}
						class="mt-2 rounded-lg bg-yellow-500 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-yellow-600 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-opacity-50"
						disabled={isUploading}
					>
						{isUploading ? 'Processing...' : 'Continue Transcription'}
					</button>
				</div>
			{:else}
				<button
					on:click={downloadTranscript}
					class="w-full rounded-lg bg-green-500 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-green-600 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50"
				>
					Download Transcript
				</button>
			{/if}
		{:else}
			<div class="mb-8 rounded-lg bg-white p-6 shadow-md">
				<h2 class="mb-4 text-2xl font-semibold">Upload Your File</h2>
				<Label for="audio-file" class="mb-2 block text-sm font-medium text-gray-700"
					>Select an audio or video file</Label
				>
				<Input
					type="file"
					on:input={handleFileInput}
					id="audio-file"
					accept="audio/*,video/*"
					class="mb-4 w-full cursor-pointer rounded-lg border border-gray-300 bg-gray-50 p-2.5 text-sm text-gray-900 focus:border-blue-500 focus:ring-blue-500"
				/>
				<button
					on:click|preventDefault={() => handleSubmit()}
					class="mb-4 w-full rounded-lg bg-blue-500 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 disabled:cursor-not-allowed disabled:bg-gray-400"
					disabled={!selectedFile || isUploading}
				>
					{isUploading ? 'Processing...' : 'Upload File'}
				</button>

				<p class="space-y-2 text-sm text-gray-700">
					Transcribe mp3, wav, mp4, avi & more. Duration limit of 1 hour per file. This app uses an
					experimental model. If processing fails, please try again.
				</p>

				{#if isUploading}
					<p class="mt-2 text-sm font-bold text-gray-600">
						Processing file - this may take a few minutes.
					</p>
				{:else}
					<button
						on:click={useSample}
						class="mt-4 text-sm text-gray-600 underline hover:text-gray-800 focus:outline-none"
					>
						Try transcribing a sample file
					</button>
				{/if}
			</div>
		{/if}

		<div class="mb-2">
			{streamBuffer}
		</div>

		<div class="transcript mt-8">
			{#each transcriptArray as entry, i (entry.timestamp + '-' + entry.speaker)}
				<div class="mb-4 rounded-lg {i % 2 === 0 ? 'bg-gray-50' : 'bg-white'} p-4 shadow-sm">
					<button
						class="mb-2 block rounded-full bg-blue-500 px-3 py-1 text-sm font-bold text-white shadow-md transition duration-300 ease-in-out hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
						on:click={() => handleTimestampClick(entry.timestamp)}
					>
						{entry.timestamp}
					</button>
					<span class="font-bold text-gray-700">{entry.speaker}:</span>
					<span class="text-gray-800">{entry.text}</span>
				</div>
			{/each}
		</div>
	</div>
</main>

