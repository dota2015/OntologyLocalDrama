const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const videoMergeService = require('../src/services/videoMergeService');

const warnings = [];
const log = { info() {}, warn: (...a) => warnings.push(a), error() {}, debug() {} };

describe('buildConcatArgs', () => {
  it('uses stream copy by default (fast, lossless)', () => {
    const args = videoMergeService.buildConcatArgs('/tmp/list.txt', '/tmp/out.mp4');
    assert.deepEqual(args, ['-f', 'concat', '-safe', '0', '-i', '/tmp/list.txt', '-c', 'copy', '-y', '/tmp/out.mp4']);
  });

  it('uses re-encode args when transcode is requested (mixed-parameter clips fallback)', () => {
    const args = videoMergeService.buildConcatArgs('/tmp/list.txt', '/tmp/out.mp4', true);
    assert.equal(args.includes('-c:v'), true);
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.equal(args.includes('-movflags'), true);
    assert.equal(args.includes('-c'), false);
    assert.equal(args[args.length - 1], '/tmp/out.mp4');
  });
});

describe('runFfmpegConcat', () => {
  it('returns false when clips cannot be concatenated (no ffmpeg / missing inputs)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-concat-'));
    const outputPath = path.join(dir, 'merged.mp4');
    const missing = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];

    const ok = videoMergeService.runFfmpegConcat(missing, outputPath, log);

    assert.equal(ok, false);
    assert.equal(fs.existsSync(outputPath), false);
    // concat list 文件必须被清理，不残留临时文件
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith('concat_list_')),
      []
    );
  });
});

describe('appendBlackTail', () => {
  it('returns false for non-existent files or 0-duration padding', () => {
    assert.equal(videoMergeService.appendBlackTail('/tmp/non_existent_file_xyz.mp4', 1.0, log), false);
    assert.equal(videoMergeService.appendBlackTail('/tmp/non_existent_file_xyz.mp4', 0, log), false);
  });

  it('appends black frame tail to video and syncs duration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-black-tail-'));
    const testVideo = path.join(dir, 'sample.mp4');
    const { spawnSync } = require('child_process');
    const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

    // Create 2-second test video with audio
    spawnSync(getFfmpegPath(), [
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264', '-c:a', 'aac',
      '-t', '2', '-y', testVideo
    ]);

    const beforeProbe = spawnSync(getFfprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', testVideo], { encoding: 'utf8' });
    const durBefore = parseFloat(JSON.parse(beforeProbe.stdout).format.duration);
    assert.ok(durBefore >= 1.9 && durBefore <= 2.1);

    const ok = videoMergeService.appendBlackTail(testVideo, 1.0, log);
    assert.equal(ok, true);

    const afterProbe = spawnSync(getFfprobePath(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', testVideo], { encoding: 'utf8' });
    const meta = JSON.parse(afterProbe.stdout);
    const durAfter = parseFloat(meta.format.duration);
    assert.ok(durAfter >= 2.9 && durAfter <= 3.1);

    // Verify both video and audio stream exist
    const hasVideo = meta.streams.some(s => s.codec_type === 'video');
    const hasAudio = meta.streams.some(s => s.codec_type === 'audio');
    assert.equal(hasVideo, true);
    assert.equal(hasAudio, true);

    // Clean up
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
