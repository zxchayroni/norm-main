# Production-развёртывание НормАрхива на Ubuntu Server 24.04 LTS

Инструкция устанавливает приложение с нуля на чистый Ubuntu Server 24.04 LTS для использования только в локальной сети. Node.js запускает приложение под отдельной системной учётной записью, PostgreSQL хранит метаданные, файлы лежат вне web-каталога, systemd обеспечивает автозапуск, а Nginx принимает HTTPS с сертификатом вашей ИТ-службы. Для ссылок редактирования DOCX/XLSX задаётся HTTPS-адрес архива.

До установки попросите ИТ-службу закрепить локальный IP сервера, настроить внутреннюю DNS-запись (в примерах ниже `archive.intra.example`) и выдать сертификат TLS для этого имени вместе с цепочкой сертификатов. Устройства пользователей и Microsoft Office должны доверять корневому сертификату организации. Не настраивайте переадресацию портов на роутере и не публикуйте сервер в интернете.

## 1. Подготовить сервер и сеть

Обновите Ubuntu и установите необходимые инструменты:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl git build-essential python3 nginx postgresql postgresql-contrib ufw
```

Узнайте локальную подсеть сервера:

```bash
ip -4 route
hostname -I
```

В выводе `ip -4 route` найдите локальный маршрут вида `192.168.1.0/24 dev ...`; это пример локальной подсети, у вашего сервера она может быть другой. Зафиксируйте IP-адрес сервера в настройках роутера через DHCP reservation, чтобы адрес не менялся. На роутере не включайте переадресацию портов и UPnP для сервера.

Ограничьте SSH и HTTPS своей локальной подсетью. В командах ниже замените `192.168.1.0/24` на подсеть, которую показал `ip -4 route`:

```bash
sudo ufw default deny incoming
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 443 proto tcp
sudo ufw enable
sudo ufw status
```

Если сервер уже администрируется через SSH, убедитесь, что IP-адрес вашего компьютера входит в разрешённую подсеть до включения UFW, иначе SSH-соединение может оборваться.

## 2. Установить Node.js

В репозитории используется Node.js версии не ниже 22.12. Установите актуальную версию ветки 22 из репозитория NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

Убедитесь, что `node --version` показывает `v22.12.0` или новее.

## 3. Создать базу PostgreSQL

Откройте консоль PostgreSQL от имени системного администратора:

```bash
sudo -u postgres psql
```

В консоли PostgreSQL выполните команды. После `\password` введите надёжный пароль роли приложения; сохраните его — он понадобится в следующем шаге.

```text
CREATE ROLE normarchive_app LOGIN;
\password normarchive_app
CREATE DATABASE normarchive OWNER normarchive_app;
\q
```

Пароль будет вводиться интерактивно, а не сохраняться в истории команд. Порт PostgreSQL не нужно открывать для внешней сети: приложение и база работают на одном сервере.

Убедитесь, что PostgreSQL включён при запуске системы:

```bash
sudo systemctl enable --now postgresql
sudo systemctl is-active postgresql
```

## 4. Подготовить учётную запись и файлы приложения

Создайте отдельную системную учётную запись для приложения и каталог хранилища документов:

```bash
sudo adduser --system --group --home /opt/normarchive normarchive
sudo install -d -o normarchive -g normarchive /opt/normarchive/app /var/lib/normarchive/files
```

Установите версию проекта из GitHub. Для production используйте проверенный тег релиза или полный commit hash, а не произвольное текущее состояние основной ветки. Откройте страницу нужного репозитория, нажмите **Code → HTTPS → Copy URL**, затем подставьте скопированный адрес вместо примера ниже:

```bash
sudo -u normarchive git clone https://github.com/OWNER/REPOSITORY.git /opt/normarchive/app
sudo -u normarchive git -C /opt/normarchive/app checkout --detach RELEASE_TAG_OR_COMMIT
```

Замените адрес репозитория, `RELEASE_TAG_OR_COMMIT` и остальные примеры на реальные значения. Для закрытого репозитория настройте на сервере безопасную авторизацию GitHub с доступом только на чтение; не вставляйте пароль или токен в URL и не сохраняйте их в командах. Не переносите исходный код, `node_modules`, `dist` или `.env` с Windows: исходники берутся с GitHub, зависимости и сборка создаются на Ubuntu, а секреты настраиваются отдельно.

Установите зависимости:

```bash
cd /opt/normarchive/app
sudo -u normarchive npm ci
```

## 5. Настроить переменные окружения

Создайте файл конфигурации, доступный только root и группе службы:

```bash
sudo install -d -o root -g normarchive -m 0750 /etc/normarchive
sudo nano /etc/normarchive/normarchive.env
```

Добавьте строки ниже. Замените `archive.intra.example` на внутреннее DNS-имя сервера; укажите настоящий пароль PostgreSQL и случайный ключ TOTP. Сгенерировать пароль из шестнадцатеричных символов и ключ можно командами `openssl rand -hex 24` и `openssl rand -hex 32` соответственно; такой пароль безопасно вставлять в URL подключения к БД.

```dotenv
DATABASE_URL=postgresql://normarchive_app:ВСТАВЬТЕ_ПАРОЛЬ@127.0.0.1:5432/normarchive
DB_POOL_SIZE=20
ARCHIVE_STORAGE_DIR=/var/lib/normarchive/files
TOTP_ENCRYPTION_KEY=ВСТАВЬТЕ_64_ШЕСТНАДЦАТЕРИЧНЫХ_СИМВОЛА
HOST=127.0.0.1
PORT=4321
APP_ALLOWED_HOSTS=localhost,127.0.0.1,archive.intra.example
PUBLIC_BASE_URL=https://archive.intra.example
```

`PUBLIC_BASE_URL` должен быть внешним HTTPS-адресом, по которому сервер достижим с рабочих станций и Microsoft Office; не указывайте `localhost`, IP-адрес, путь или завершающий `/`. Не меняйте `TOTP_ENCRYPTION_KEY` после настройки пользователями двухфакторной аутентификации: без прежнего ключа сохранённые TOTP-секреты нельзя расшифровать. В `APP_ALLOWED_HOSTS` указывайте имена хостов без схемы, пути и порта. Astro использует список при проверке запроса и заголовков обратного прокси; после его изменения production-сборку нужно выполнить заново.

Сохраните файл в nano (`Ctrl+O`, `Enter`, `Ctrl+X`) и ограничьте доступ:

```bash
sudo chown root:normarchive /etc/normarchive/normarchive.env
sudo chmod 640 /etc/normarchive/normarchive.env
```

## 6. Применить миграции базы данных

Загрузите настройки из файла и запустите миграции:

```bash
sudo -u normarchive bash -c 'set -a; source /etc/normarchive/normarchive.env; set +a; cd /opt/normarchive/app; npm run db:migrate'
```

При успехе появятся строки `Applied: ...`. Миграции, которые уже применялись, будут пропущены.

## 7. Создать первого администратора

Запустите shell от имени службы:

```bash
sudo -u normarchive bash
```

В открывшейся оболочке выполните команды. Пароль администратора вводится без отображения на экране; он должен содержать не менее 12 символов.

```bash
set -a
source /etc/normarchive/normarchive.env
set +a
cd /opt/normarchive/app
read -r -p "Логин администратора: " BOOTSTRAP_ADMIN_USERNAME
read -r -s -p "Пароль администратора: " BOOTSTRAP_ADMIN_PASSWORD; echo
read -r -p "Имя администратора: " BOOTSTRAP_ADMIN_NAME
export BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_ADMIN_NAME
npm run admin:create
unset BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_ADMIN_NAME
exit
```

Создание первого администратора доступно только пока в базе ещё нет администраторов.

## 8. Запустить приложение как службу systemd

Соберите production-версию с настроенными значениями `APP_ALLOWED_HOSTS` и проверьте наличие серверного файла:

```bash
sudo -u normarchive bash -c 'set -a; source /etc/normarchive/normarchive.env; set +a; cd /opt/normarchive/app; npm run build'
test -f /opt/normarchive/app/dist/server/entry.mjs
```

Создайте описание службы:

```bash
sudo nano /etc/systemd/system/normarchive.service
```

Содержимое файла:

```ini
[Unit]
Description=НормАрхив
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=normarchive
Group=normarchive
WorkingDirectory=/opt/normarchive/app
EnvironmentFile=/etc/normarchive/normarchive.env
ExecStart=/usr/bin/node /opt/normarchive/app/dist/server/entry.mjs
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/normarchive/files

[Install]
WantedBy=multi-user.target
```

Загрузите службу, включите её автозапуск и запустите приложение:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now normarchive
sudo systemctl status normarchive
```

Проверить журнал запуска можно командой:

```bash
sudo journalctl -u normarchive -n 50 --no-pager
```

Убедитесь, что приложение отвечает локально:

```bash
curl -I http://127.0.0.1:4321/
```

Если служба не запустилась, проверьте журнал, пути, права доступа и значения в `/etc/normarchive/normarchive.env`.

## 9. Настроить HTTPS-доступ через Nginx

Получите от ИТ-службы сертификат сервера и полную цепочку сертификатов для `archive.intra.example`. Установите файлы на сервер, не помещая закрытый ключ в репозиторий:

```bash
sudo install -d -o root -g root -m 0700 /etc/nginx/tls
sudo install -o root -g root -m 0600 /ПУТЬ/ОТ-ИТ/fullchain.pem /etc/nginx/tls/fullchain.pem
sudo install -o root -g root -m 0600 /ПУТЬ/ОТ-ИТ/private.key /etc/nginx/tls/private.key
```

Проверьте срок действия сертификата и имя в SAN. Сравните отпечатки открытых ключей сертификата и private key: значения SHA256 должны совпадать.

```bash
sudo openssl x509 -in /etc/nginx/tls/fullchain.pem -noout -dates -ext subjectAltName
sudo openssl x509 -in /etc/nginx/tls/fullchain.pem -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum
sudo openssl pkey -in /etc/nginx/tls/private.key -pubout -outform DER | sha256sum
```

Попросите ИТ-службу установить корневой сертификат организации в доверенные не только на рабочих станциях, но и на сервере, если он нужен для локальной проверки `curl`. При замене TLS-сертификата сначала обновите файлы, затем проверьте конфигурацию и перезагрузите Nginx: `sudo nginx -t && sudo systemctl reload nginx`. Запланируйте замену сертификата до истечения срока действия совместно с ИТ-службой.

Создайте конфигурацию Nginx:

```bash
sudo nano /etc/nginx/sites-available/normarchive
```

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name archive.intra.example;

    ssl_certificate /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/private.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 110m;

    location / {
        proxy_pass http://127.0.0.1:4321;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Замените имя сервера на внутреннее DNS-имя из сертификата. Лимит Nginx нужен для загрузки файлов приложения размером до 100 МБ. Приложение должно оставаться доступным только через Nginx: `HOST=127.0.0.1`, а порт `4321` нельзя открывать в UFW или на маршрутизаторе. Nginx перезаписывает `X-Forwarded-Proto` и `X-Forwarded-Host`; приложение использует HTTPS-схему для защищённого session-cookie. Не публикуйте порт приложения напрямую. Включите сайт и проверьте конфигурацию:

```bash
sudo ln -s /etc/nginx/sites-available/normarchive /etc/nginx/sites-enabled/normarchive
if [ -L /etc/nginx/sites-enabled/default ]; then sudo unlink /etc/nginx/sites-enabled/default; fi
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

Если команда `ln` сообщает, что ссылка уже существует, проверьте её и не перезаписывайте неизвестную конфигурацию. Проверьте адрес сайта:

```bash
curl -I https://archive.intra.example/
```

Откройте `https://archive.intra.example/` на рабочей станции. Если сертификат выдан внутренним центром сертификации, ИТ-служба должна установить его корневой сертификат в доверенные на рабочих станциях и устройствах, с которых запускают Microsoft Office. Не обходите предупреждение браузера о недоверенном или неверном сертификате.

Войдите под созданным администратором. Проверьте создание пользователя и назначение роли, вход/выход, загрузку и скачивание файла, предпросмотр импорта и создание ссылки редактирования для DOCX/XLSX. Убедитесь, что Office открывает эту ссылку именно через внутреннее HTTPS-имя, а компьютер вне разрешённой подсети не имеет доступа к портам сервера.

## 10. Резервное копирование, обновление и восстановление

Настройте согласованную резервную копию базы PostgreSQL и каталога файлов. Скрипт останавливает приложение на время копирования, создаёт архивы с ограниченными правами и при успехе или ошибке пытается снова запустить службу. Установите его:

```bash
sudo install -o root -g root -m 0750 /opt/normarchive/app/scripts/backup-linux.sh /usr/local/sbin/normarchive-backup
```

Создайте `/etc/systemd/system/normarchive-backup.service`:

```ini
[Unit]
Description=Backup NormArchive database and files
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/normarchive-backup
```

Создайте `/etc/systemd/system/normarchive-backup.timer`:

```ini
[Unit]
Description=Daily NormArchive backup

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
Unit=normarchive-backup.service

[Install]
WantedBy=timers.target
```

Перед включением таймера согласуйте с ИТ-службой срок хранения локальных копий, их защищённую передачу на отдельное хранилище и контроль свободного места. Скрипт намеренно не удаляет старые архивы автоматически.

Включите таймер и выполните пробную копию:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now normarchive-backup.timer
sudo systemctl start normarchive-backup.service
sudo systemctl status normarchive-backup.service
sudo ls -lh /var/backups/normarchive
sudo systemctl is-active normarchive
```

При ошибке задания проверьте `sudo journalctl -u normarchive-backup.service`. Проверяйте расписание и свободное место командой `df -h /var/backups`. Храните копии за пределами этого сервера в защищённом месте с доступом только уполномоченных лиц; локальная копия не защищает от отказа диска или потери сервера. Отдельно сохраните `/etc/normarchive/normarchive.env` и прежний `TOTP_ENCRYPTION_KEY` в защищённом хранилище секретов: backup-скрипт их не копирует. Регулярно проверяйте восстановление на отдельной тестовой системе. Не обновляйте приложение, если последняя резервная копия завершилась ошибкой или основная служба не вернулась в состояние `active`.

Перед обновлением получите резервную копию и сохраните используемый тег/коммит как точку возврата. Затем остановите приложение, получите выбранный проверенный релиз, установите зависимости, соберите приложение, примените миграции и снова запустите службу:

```bash
sudo systemctl stop normarchive
sudo -u normarchive git -C /opt/normarchive/app fetch --tags
sudo -u normarchive git -C /opt/normarchive/app checkout --detach RELEASE_TAG_OR_COMMIT
sudo -u normarchive npm --prefix /opt/normarchive/app ci
sudo -u normarchive bash -c 'set -a; source /etc/normarchive/normarchive.env; set +a; cd /opt/normarchive/app; npm run build'
sudo -u normarchive bash -c 'set -a; source /etc/normarchive/normarchive.env; set +a; cd /opt/normarchive/app; npm run db:migrate'
sudo systemctl start normarchive
sudo systemctl status normarchive
curl -I https://archive.intra.example/
```

Если сборка или миграция завершилась ошибкой, не запускайте частично обновлённую версию. Вернитесь к ранее зафиксированному тегу/commit и повторите сборку; если миграция уже изменила схему, следуйте плану восстановления базы из резервной копии.

База и файлы архива — отдельные части данных; регулярно сохраняйте обе и проверяйте восстановление резервной копии. Если переносите существующий архив с Windows, перенесите дамп PostgreSQL и всё содержимое `ARCHIVE_STORAGE_DIR`, восстановите структуру файлов и сохраните прежний `TOTP_ENCRYPTION_KEY`. Не копируйте `node_modules` или `dist` с Windows.

Для восстановления из примера выше сначала остановите службу. Эти команды заменят текущее содержимое базы и файлов, поэтому используйте их только на подготовленном сервере или после сохранения текущих данных:

```bash
sudo systemctl stop normarchive
sudo -u postgres pg_restore --clean --if-exists --no-owner --role=normarchive_app -d normarchive /var/backups/normarchive/ИМЯ_РЕЗЕРВНОЙ_КОПИИ.dump
sudo tar -xzf /var/backups/normarchive/ИМЯ_РЕЗЕРВНОЙ_КОПИИ.tar.gz -C /var/lib/normarchive
sudo chown -R normarchive:normarchive /var/lib/normarchive/files
sudo systemctl start normarchive
```

Подставьте имена файлов базы и файлового архива с одинаковой временной меткой из одного запуска backup-скрипта. У восстановленного сервера должны быть совместимые версии PostgreSQL и проекта, исходный `/etc/normarchive/normarchive.env` и прежний `TOTP_ENCRYPTION_KEY`; после восстановления проверьте вход, документы и открытие файлов.

Для просмотра журнала службы используйте `sudo journalctl -u normarchive -f`. Для остановки и запуска приложения — `sudo systemctl stop normarchive` и `sudo systemctl start normarchive`.
