-- Share of each subclass's combined score that comes from pixel math (0 = SigLIP only).
-- The UI shows "measured" (> 0) vs "perceived" (= 0) badges from this.
alter table subclasses add column pixel_weight real not null default 0;
