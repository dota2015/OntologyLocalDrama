-- 27_storyboard_long_take.sql
-- 增加长镜头结构化标记与接力控制列

ALTER TABLE storyboards ADD COLUMN long_take_group_id TEXT;
ALTER TABLE storyboards ADD COLUMN long_take_role TEXT;
ALTER TABLE storyboards ADD COLUMN long_take_sequence INTEGER;
