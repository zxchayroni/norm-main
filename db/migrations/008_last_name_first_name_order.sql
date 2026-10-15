UPDATE users
SET full_name = concat_ws(
	' ',
	NULLIF(btrim(last_name), ''),
	NULLIF(btrim(first_name), ''),
	NULLIF(btrim(patronymic), '')
);
