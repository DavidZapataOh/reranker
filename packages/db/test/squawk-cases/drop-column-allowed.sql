-- No deployed release reads legacy_name anymore.
-- squawk-ignore ban-drop-column
ALTER TABLE "app"."businesses" DROP COLUMN "legacy_name";
