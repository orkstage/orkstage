-- Open item 13: deprecated template versions, and published versions that never change.
ALTER TABLE "TemplateVersion" ADD COLUMN "deprecatedAt" TIMESTAMPTZ(3),
ADD COLUMN "deprecationNote" TEXT;

-- Existing deprecated rows get a date.
UPDATE "TemplateVersion" SET "deprecatedAt" = now() WHERE status = 'DEPRECATED' AND "deprecatedAt" IS NULL;

-- Instances record the version they run: its source and document are frozen once it leaves draft.
CREATE FUNCTION "TemplateVersion_frozen"() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (NEW.source IS DISTINCT FROM OLD.source OR NEW.document IS DISTINCT FROM OLD.document OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'template version % is % and cannot change', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'DRAFT' AND NEW.status = 'DRAFT' THEN
    RAISE EXCEPTION 'template version % cannot go back to draft', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TemplateVersion_frozen" BEFORE UPDATE ON "TemplateVersion" FOR EACH ROW EXECUTE FUNCTION "TemplateVersion_frozen"();
