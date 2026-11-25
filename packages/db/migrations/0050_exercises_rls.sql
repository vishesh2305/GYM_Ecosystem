-- Person-owned tables (training data): rows are visible and writable only for app.user_id. Call once per table.
CREATE OR REPLACE FUNCTION app.enable_user_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS own_rows ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY own_rows ON %s USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())',
    tbl
  );
END
$$;
--> statement-breakpoint

-- Exercises: a person reads and writes their own; everyone reads the shared library (user_id null).
SELECT app.enable_user_rls('exercises');
--> statement-breakpoint
CREATE POLICY shared_library ON exercises FOR SELECT USING (user_id IS NULL);
--> statement-breakpoint

-- The shared library. Slugs are stable keys: rename freely, never reuse a slug for another exercise.
INSERT INTO exercises (id, slug, name, primary_muscle, secondary_muscles, equipment, tracking) VALUES
  (gen_random_uuid(), 'barbell-bench-press', 'Bench Press (Barbell)', 'chest', '{triceps,shoulders}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'dumbbell-bench-press', 'Bench Press (Dumbbell)', 'chest', '{triceps,shoulders}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'incline-barbell-bench-press', 'Incline Bench Press (Barbell)', 'chest', '{shoulders,triceps}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'incline-dumbbell-press', 'Incline Press (Dumbbell)', 'chest', '{shoulders,triceps}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'machine-chest-press', 'Chest Press (Machine)', 'chest', '{triceps,shoulders}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'dumbbell-fly', 'Chest Fly (Dumbbell)', 'chest', '{shoulders}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'cable-crossover', 'Cable Crossover', 'chest', '{shoulders}', 'cable', 'weight_reps'),
  (gen_random_uuid(), 'push-up', 'Push-up', 'chest', '{triceps,shoulders}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 'chest-dip', 'Dip', 'chest', '{triceps,shoulders}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 'barbell-deadlift', 'Deadlift (Barbell)', 'back', '{hamstrings,glutes,lower_back,traps}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'trap-bar-deadlift', 'Deadlift (Trap Bar)', 'quadriceps', '{glutes,hamstrings,back}', 'trap_bar', 'weight_reps'),
  (gen_random_uuid(), 'barbell-row', 'Bent-over Row (Barbell)', 'back', '{lats,biceps}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'dumbbell-row', 'One-arm Row (Dumbbell)', 'back', '{lats,biceps}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'seated-cable-row', 'Seated Row (Cable)', 'back', '{lats,biceps}', 'cable', 'weight_reps'),
  (gen_random_uuid(), 'lat-pulldown', 'Lat Pulldown (Cable)', 'lats', '{biceps,back}', 'cable', 'weight_reps'),
  (gen_random_uuid(), 'pull-up', 'Pull-up', 'lats', '{biceps,back}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 'chin-up', 'Chin-up', 'lats', '{biceps}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 't-bar-row', 'T-Bar Row', 'back', '{lats,biceps}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'barbell-shrug', 'Shrug (Barbell)', 'traps', '{forearms}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'back-extension', 'Back Extension', 'lower_back', '{glutes,hamstrings}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 'overhead-press', 'Overhead Press (Barbell)', 'shoulders', '{triceps}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'dumbbell-shoulder-press', 'Shoulder Press (Dumbbell)', 'shoulders', '{triceps}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'machine-shoulder-press', 'Shoulder Press (Machine)', 'shoulders', '{triceps}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'lateral-raise', 'Lateral Raise (Dumbbell)', 'shoulders', '{}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'cable-lateral-raise', 'Lateral Raise (Cable)', 'shoulders', '{}', 'cable', 'weight_reps'),
  (gen_random_uuid(), 'rear-delt-fly', 'Rear Delt Fly (Dumbbell)', 'shoulders', '{back}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'face-pull', 'Face Pull (Cable)', 'shoulders', '{traps,back}', 'cable', 'weight_reps'),
  (gen_random_uuid(), 'barbell-curl', 'Bicep Curl (Barbell)', 'biceps', '{forearms}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'dumbbell-curl', 'Bicep Curl (Dumbbell)', 'biceps', '{forearms}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'hammer-curl', 'Hammer Curl (Dumbbell)', 'biceps', '{forearms}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'ez-bar-preacher-curl', 'Preacher Curl (EZ Bar)', 'biceps', '{}', 'ez_bar', 'weight_reps'),
  (gen_random_uuid(), 'cable-curl', 'Bicep Curl (Cable)', 'biceps', '{forearms}', 'cable', 'weight_reps'),
  (gen_random_uuid(), 'triceps-pushdown', 'Triceps Pushdown (Cable)', 'triceps', '{}', 'cable', 'weight_reps'),
  (gen_random_uuid(), 'overhead-triceps-extension', 'Overhead Triceps Extension (Dumbbell)', 'triceps', '{}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'skull-crusher', 'Skull Crusher (EZ Bar)', 'triceps', '{}', 'ez_bar', 'weight_reps'),
  (gen_random_uuid(), 'close-grip-bench-press', 'Close-grip Bench Press (Barbell)', 'triceps', '{chest,shoulders}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'wrist-curl', 'Wrist Curl (Dumbbell)', 'forearms', '{}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'barbell-back-squat', 'Squat (Barbell)', 'quadriceps', '{glutes,hamstrings,lower_back}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'barbell-front-squat', 'Front Squat (Barbell)', 'quadriceps', '{glutes,abs}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'goblet-squat', 'Goblet Squat (Kettlebell)', 'quadriceps', '{glutes}', 'kettlebell', 'weight_reps'),
  (gen_random_uuid(), 'smith-machine-squat', 'Squat (Smith Machine)', 'quadriceps', '{glutes}', 'smith_machine', 'weight_reps'),
  (gen_random_uuid(), 'leg-press', 'Leg Press (Machine)', 'quadriceps', '{glutes,hamstrings}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'leg-extension', 'Leg Extension (Machine)', 'quadriceps', '{}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'walking-lunge', 'Walking Lunge (Dumbbell)', 'quadriceps', '{glutes,hamstrings}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'bulgarian-split-squat', 'Bulgarian Split Squat (Dumbbell)', 'quadriceps', '{glutes}', 'dumbbell', 'weight_reps'),
  (gen_random_uuid(), 'romanian-deadlift', 'Romanian Deadlift (Barbell)', 'hamstrings', '{glutes,lower_back}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'lying-leg-curl', 'Lying Leg Curl (Machine)', 'hamstrings', '{}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'seated-leg-curl', 'Seated Leg Curl (Machine)', 'hamstrings', '{}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'barbell-hip-thrust', 'Hip Thrust (Barbell)', 'glutes', '{hamstrings}', 'barbell', 'weight_reps'),
  (gen_random_uuid(), 'kettlebell-swing', 'Kettlebell Swing', 'glutes', '{hamstrings,lower_back}', 'kettlebell', 'weight_reps'),
  (gen_random_uuid(), 'hip-adduction', 'Hip Adduction (Machine)', 'adductors', '{}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'hip-abduction', 'Hip Abduction (Machine)', 'abductors', '{glutes}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'standing-calf-raise', 'Standing Calf Raise (Machine)', 'calves', '{}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'seated-calf-raise', 'Seated Calf Raise (Machine)', 'calves', '{}', 'machine', 'weight_reps'),
  (gen_random_uuid(), 'crunch', 'Crunch', 'abs', '{}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 'hanging-leg-raise', 'Hanging Leg Raise', 'abs', '{obliques}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 'cable-crunch', 'Cable Crunch', 'abs', '{}', 'cable', 'weight_reps'),
  (gen_random_uuid(), 'russian-twist', 'Russian Twist', 'obliques', '{abs}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 'plank', 'Plank', 'abs', '{obliques,shoulders}', 'bodyweight', 'time'),
  (gen_random_uuid(), 'farmers-walk', 'Farmer''s Walk (Dumbbell)', 'forearms', '{traps,full_body}', 'dumbbell', 'distance'),
  (gen_random_uuid(), 'burpee', 'Burpee', 'full_body', '{chest,quadriceps}', 'bodyweight', 'reps'),
  (gen_random_uuid(), 'treadmill-run', 'Running (Treadmill)', 'cardio', '{quadriceps,calves}', 'cardio_machine', 'distance'),
  (gen_random_uuid(), 'outdoor-run', 'Running (Outdoor)', 'cardio', '{quadriceps,calves}', 'bodyweight', 'distance'),
  (gen_random_uuid(), 'stationary-bike', 'Cycling (Stationary Bike)', 'cardio', '{quadriceps}', 'cardio_machine', 'distance'),
  (gen_random_uuid(), 'rowing-machine', 'Rowing (Machine)', 'cardio', '{back,quadriceps}', 'cardio_machine', 'distance'),
  (gen_random_uuid(), 'elliptical', 'Elliptical', 'cardio', '{}', 'cardio_machine', 'time'),
  (gen_random_uuid(), 'stair-climber', 'Stair Climber', 'cardio', '{glutes,quadriceps}', 'cardio_machine', 'time'),
  (gen_random_uuid(), 'jump-rope', 'Jump Rope', 'cardio', '{calves}', 'other', 'time')
ON CONFLICT (slug) DO NOTHING;
