export type WavFormat = Readonly<{ channels: number; sampleRate: number; bits: number }>;

// 非圧縮PCMのWAVから形式とPCM部分を取り出す。
export function readPcmWav(wav: Buffer): Readonly<{ format: WavFormat; pcm: Buffer }> {
	if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("not a WAV file");
	}
	let offset = 12;
	let format: WavFormat | undefined;
	while (offset + 8 <= wav.length) {
		const id = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			format = {
				channels: wav.readUInt16LE(body + 2),
				sampleRate: wav.readUInt32LE(body + 4),
				bits: wav.readUInt16LE(body + 14),
			};
		} else if (id === "data") {
			if (format === undefined) throw new Error("WAV has no fmt chunk before its data");
			return { format, pcm: wav.subarray(body, Math.min(body + size, wav.length)) };
		}
		// チャンクは偶数バイト境界にそろえて並ぶ。
		offset = body + size + (size % 2);
	}
	throw new Error("WAV has no data chunk");
}

// 16bitモノラルを、左右に同じ値を並べたステレオにする。
export function monoToStereo(pcm: Buffer): Buffer {
	const stereo = Buffer.alloc(pcm.length * 2);
	for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
		const sample = pcm.readInt16LE(offset);
		stereo.writeInt16LE(sample, offset * 2);
		stereo.writeInt16LE(sample, offset * 2 + 2);
	}
	return stereo;
}
