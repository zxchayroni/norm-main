ALTER TABLE users
	ADD COLUMN first_name TEXT NOT NULL DEFAULT '',
	ADD COLUMN last_name TEXT NOT NULL DEFAULT '',
	ADD COLUMN patronymic TEXT NOT NULL DEFAULT '';

UPDATE users
SET first_name = name_parts[1],
	last_name = COALESCE(name_parts[2], ''),
	patronymic = COALESCE(array_to_string(name_parts[3:], ' '), '')
FROM (
	SELECT id, regexp_split_to_array(btrim(full_name), '\s+') AS name_parts
	FROM users
) AS existing_names
WHERE users.id = existing_names.id;
