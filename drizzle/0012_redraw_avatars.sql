-- The look-alike rules changed (white cats with patches, cap, colourpoint). Clearing every stored avatar lets the
-- existing avatar backfill job redraw each cat from its coat. Until it runs, the yard shows the neutral cat.
UPDATE "cats" SET "avatar" = NULL;
