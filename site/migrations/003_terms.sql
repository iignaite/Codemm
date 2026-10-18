-- Which version of the Terms of Use each subscriber accepted (public/terms.html),
-- as proof of agreement. Existing rows predate the Terms and stay NULL.
-- consent now means "chose to get release emails" (an optional box), not "signed up".
ALTER TABLE subscribers ADD COLUMN terms_version TEXT
