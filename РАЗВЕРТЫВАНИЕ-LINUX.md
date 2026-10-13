# Развёртывание НормАрхива на Ubuntu Server 24.04 LTS

Инструкция устанавливает приложение на чистый сервер Ubuntu 24.04 LTS для использования только в локальной сети: Node.js запускает приложение, PostgreSQL хранит данные, Nginx принимает запросы по HTTP. Пользователи открывают архив в браузере по локальному IP-адресу сервера; домен и доступ из интернета не нужны.

Все устройства, которым нужен архив, должны быть в одной доверенной локальной сети. HTTP не шифрует пароль и передаваемые документы; не используйте эту конфигурацию в общедоступной Wi-Fi-сети или для конфиденциальных данных без HTTPS, настроенного вашей ИТ-службой. Не настраивайте переадресацию портов на роутере и не открывайте веб-порт во внешний интернет.

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

Ограничьте SSH и HTTP своей локальной подсетью. В командах ниже замените `192.168.1.0/24` на подсеть, которую показал `ip -4 route`:

```bash
sudo ufw default deny incoming
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 80 proto tcp
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

## 4. Подготовить учётную запись и файлы приложения

Создайте отдельную системную учётную запись для приложения и каталог хранилища документов:

```bash
sudo adduser --system --group --home /opt/normarchive normarchive
sudo install -d -o normarchive -g normarchive /opt/normarchive/app /var/lib/normarchive/files
```

Скопируйте исходный код проекта в `/opt/normarchive/app` или клонируйте репозиторий, например:

```bash
sudo -u normarchive git clone git@github.com:ORG/REPO.git /opt/normarchive/app
```

Замените `ORG/REPO` на адрес репозитория. Для закрытого репозитория заранее настройте SSH-ключ с доступом только на чтение; не помещайте пароль или токен в адрес репозитория. При копировании проекта не переносите `node_modules`, `dist` и `.env` с Windows: зависимости и сборку нужно создать на сервере, а секреты настроить отдельно.

Установите зависимости и соберите приложение:

```bash
cd /opt/normarchive/app
sudo -u normarchive npm ci
sudo -u normarchive npm run build
```

Сборка должна завершиться без ошибки и создать файл `dist/server/entry.mjs`.

## 5. Настроить переменные окружения

Создайте файл конфигурации, доступный только root и группе службы:

```bash
sudo install -d -o root -g normarchive -m 0750 /etc/normarchive
sudo nano /etc/normarchive/normarchive.env
```

Добавьте строки ниже. Укажите настоящий пароль PostgreSQL и случайный ключ TOTP. Сгенерировать пароль из шестнадцатеричных символов и ключ можно командами `openssl rand -hex 24` и `openssl rand -hex 32` соответственно; такой пароль безопасно вставлять в URL подключения к БД.

```dotenv
DATABASE_URL=postgresql://normarchive_app:ВСТАВЬТЕ_ПАРОЛЬ@127.0.0.1:5432/normarchive
DB_POOL_SIZE=20
ARCHIVE_STORAGE_DIR=/var/lib/normarchive/files
TOTP_ENCRYPTION_KEY=ВСТАВЬТЕ_64_ШЕСТНАДЦАТЕРИЧНЫХ_СИМВОЛА
HOST=127.0.0.1
PORT=4321
```

`PUBLIC_BASE_URL` оставьте незаданным: он не нужен для обычной работы в локальной сети. Функция создания ссылок для редактирования Office требует HTTPS и без него недоступна. Не меняйте `TOTP_ENCRYPTION_KEY` после настройки пользователями двухфакторной аутентификации: без прежнего ключа сохранённые TOTP-секреты нельзя расшифровать.

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

## 9. Настроить локальный доступ через Nginx

Создайте конфигурацию Nginx:

```bash
sudo nano /etc/nginx/sites-available/normarchive
```

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 110m;

    location / {
        proxy_pass http://127.0.0.1:4321;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Лимит Nginx нужен для загрузки файлов приложения размером до 100 МБ. Включите сайт и проверьте конфигурацию:

```bash
sudo ln -s /etc/nginx/sites-available/normarchive /etc/nginx/sites-enabled/normarchive
if [ -L /etc/nginx/sites-enabled/default ]; then sudo unlink /etc/nginx/sites-enabled/default; fi
sudo nginx -t
sudo systemctl reload nginx
```

Если команда `ln` сообщает, что ссылка уже существует, проверьте её и не перезаписывайте неизвестную конфигурацию. Узнайте адрес сервера командой `hostname -I`. На сервере откройте `http://127.0.0.1`; с другого компьютера или телефона в той же локальной сети откройте `http://АДРЕС_СЕРВЕРА`, например `http://192.168.1.20`. Используйте IP-адрес, закреплённый за сервером в настройках роутера.

Войдите под созданным администратором. Убедитесь, что компьютер в другой сети не имеет доступа к серверу, а на роутере не настроена переадресация портов. Трафик по HTTP не шифруется; для недоверенной сети настройте HTTPS с внутренним сертификатом через администратора вашей сети.

## 10. Обновление и сохранность данных

Перед обновлением сделайте резервные копии PostgreSQL и каталога `/var/lib/normarchive/files`. Пример ручной резервной копии с короткой остановкой приложения:

```bash
sudo systemctl stop normarchive
sudo install -d -m 700 /var/backups/normarchive
set -o pipefail
STAMP=$(date +%F_%H%M%S)
sudo -u postgres pg_dump -Fc normarchive | sudo tee "/var/backups/normarchive/db-$STAMP.dump" >/dev/null
sudo tar -czf "/var/backups/normarchive/files-$STAMP.tar.gz" -C /var/lib/normarchive files
sudo systemctl start normarchive
```

Храните резервные копии отдельно от сервера и ограничьте к ним доступ: в архиве файлов могут быть конфиденциальные документы. Проверьте, что обе команды резервного копирования завершились успешно, прежде чем продолжать.
Если резервное копирование завершилось ошибкой, не продолжайте обновление; при необходимости запустите приложение командой `sudo systemctl start normarchive`.

Для обновления остановите приложение, получите новую версию кода, установите зависимости, соберите приложение, примените миграции и снова запустите службу:

```bash
sudo systemctl stop normarchive
sudo -u normarchive git -C /opt/normarchive/app pull --ff-only
sudo -u normarchive npm --prefix /opt/normarchive/app ci
sudo -u normarchive npm --prefix /opt/normarchive/app run build
sudo -u normarchive bash -c 'set -a; source /etc/normarchive/normarchive.env; set +a; cd /opt/normarchive/app; npm run db:migrate'
sudo systemctl start normarchive
sudo systemctl status normarchive
```

База и файлы архива — отдельные части данных; регулярно сохраняйте обе и проверяйте восстановление резервной копии. Если переносите существующий архив с Windows, перенесите дамп PostgreSQL и всё содержимое `ARCHIVE_STORAGE_DIR`, восстановите структуру файлов и сохраните прежний `TOTP_ENCRYPTION_KEY`. Не копируйте `node_modules` или `dist` с Windows.

Для восстановления из примера выше сначала остановите службу. Эти команды заменят текущее содержимое базы и файлов, поэтому используйте их только на подготовленном сервере или после сохранения текущих данных:

```bash
sudo systemctl stop normarchive
sudo -u postgres pg_restore --clean --if-exists --no-owner --role=normarchive_app -d normarchive /var/backups/normarchive/ИМЯ_РЕЗЕРВНОЙ_КОПИИ.dump
sudo tar -xzf /var/backups/normarchive/ИМЯ_РЕЗЕРВНОЙ_КОПИИ.tar.gz -C /var/lib/normarchive
sudo chown -R normarchive:normarchive /var/lib/normarchive/files
sudo systemctl start normarchive
```

Подставьте соответствующие имена файлов резервных копий. У восстановленного сервера должны быть совместимые версии PostgreSQL и проекта; после восстановления проверьте вход, документы и открытие файлов.

Для просмотра журнала службы используйте `sudo journalctl -u normarchive -f`. Для остановки и запуска приложения — `sudo systemctl stop normarchive` и `sudo systemctl start normarchive`.
