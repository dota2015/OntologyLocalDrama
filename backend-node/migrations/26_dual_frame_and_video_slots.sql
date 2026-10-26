-- 26_dual_frame_and_video_slots.sql
-- 影视视听本体：为 storyboards 增加首尾帧双关键帧槽位 (last_frame_visuals) 与视频语义槽位 (video_slots)

ALTER TABLE storyboards ADD COLUMN last_frame_visuals TEXT;
ALTER TABLE storyboards ADD COLUMN video_slots TEXT;
