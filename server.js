import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import Jimp from "jimp";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENTS_DIR = path.join(process.cwd(), "clients");
if (!fs.existsSync(CLIENTS_DIR)) fs.mkdirSync(CLIENTS_DIR);

// Настройка multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static("clients"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Octokit для GitHub
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Загрузка кодов подписки
const codesPath = path.join(process.cwd(), "codes.json");
let codes = {};
if (fs.existsSync(codesPath)) {
  codes = JSON.parse(fs.readFileSync(codesPath, "utf-8"));
}

// === Страница для фотографов и загрузки ===
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "frontend", "upload.html")); // вынесли дизайн отдельно
});

// === Обработка загрузки файлов с проверкой кода ===
app.post(
  "/upload",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "video", maxCount: 1 },
    { name: "mind", maxCount: 1 },
    { name: "secretCode", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const code = req.body.secretCode;

      if (!code || !codes[code]) return res.status(403).send("Неверный или просроченный секретный код");

      const expiry = new Date(codes[code]);
      if (expiry < new Date()) return res.status(403).send("Срок действия секретного кода истёк");

      const timestamp = Date.now();
      const clientFolder = path.join(CLIENTS_DIR, `client${timestamp}`);
      fs.mkdirSync(clientFolder);

      const { photo, video, mind } = req.files;

      const photoPath = path.join(clientFolder, photo[0].originalname);
      const videoPath = path.join(clientFolder, video[0].originalname);
      const mindPath = path.join(clientFolder, mind[0].originalname);

      fs.writeFileSync(photoPath, photo[0].buffer);
      fs.writeFileSync(videoPath, video[0].buffer);
      fs.writeFileSync(mindPath, mind[0].buffer);

      // Генерация HTML
      const htmlContent = `
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>AR Фото-видео</title>
<script src="https://aframe.io/releases/1.4.0/aframe.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js"></script>
</head>
<body>
<a-scene mindar-image="imageTargetSrc: ${mind[0].originalname};" embedded>
<a-assets>
<video id="video1" src="${video[0].originalname}" preload="auto" playsinline webkit-playsinline muted></video>
</a-assets>
<a-camera position="0 0 0" look-controls="enabled: false"></a-camera>
<a-entity mindar-image-target="targetIndex: 0">
<a-video id="videoPlane" src="#video1" material="opacity: 0.65"></a-video>
</a-entity>
</a-scene>
</body>
</html>
`;
      fs.writeFileSync(path.join(clientFolder, "index.html"), htmlContent);

      // Генерация QR
      const clientUrl = `${req.protocol}://${req.get("host")}/client${timestamp}/index.html`;
      const qrPath = path.join(clientFolder, "qr.png");
      await QRCode.toFile(qrPath, clientUrl, { width: 200 });

      // Вставка QR на фото
      const image = await Jimp.read(photoPath);
      const qrImage = await Jimp.read(qrPath);
      qrImage.resize(200, 200);
      image.composite(qrImage, 10, image.bitmap.height - 210);
      const finalPhotoPath = path.join(clientFolder, "final_with_qr.jpg");
      await image.writeAsync(finalPhotoPath);

      // Публикация в GitHub
      const files = fs.readdirSync(clientFolder);
      for (const file of files) {
        const content = fs.readFileSync(path.join(clientFolder, file), { encoding: "base64" });
        await octokit.repos.createOrUpdateFileContents({
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO,
          path: `clients/client${timestamp}/${file}`,
          message: `Добавлены файлы для client${timestamp}`,
          content,
        });
      }

      res.json({
        message: "Файлы успешно загружены",
        clientUrl,
        qr: `/client${timestamp}/qr.png`,
        finalPhoto: `/client${timestamp}/final_with_qr.jpg`,
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Ошибка при обработке");
    }
  }
);

// === Админка ===
const ADMIN_CODE = process.env.ADMIN_CODE || "supersecret";

function checkAdmin(req, res, next) {
  const code = req.query.code || req.body.code;
  if (code === ADMIN_CODE) return next();
  return res.status(403).send("Доступ запрещен");
}

// Страница админки
app.get("/admin", checkAdmin, (req, res) => {
  let tableRows = "";
  for (const c in codes) {
    const expiry = new Date(codes[c]);
    const remainingDays = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
    tableRows += `<tr><td>${c}</td><td>${expiry.toLocaleString()}</td><td>${remainingDays}</td></tr>`;
  }

  res.send(`
<h2>Админка TamerlanMotion</h2>
<h3>Созданные коды</h3>
<table border="1" cellpadding="5" cellspacing="0">
<tr><th>Код</th><th>Истекает</th><th>Осталось дней</th></tr>
${tableRows}
</table>
<h3>Создать новый код</h3>
<form method="POST" action="/admin/createCode">
<input type="hidden" name="code" value="${ADMIN_CODE}">
Код: <input type="text" name="newCode" required>
Срок действия (дней): <input type="number" name="days" value="7" min="1" required>
<button type="submit">Создать</button>
</form>
`);
});

// Создание нового кода
app.post("/admin/createCode", (req, res) => {
  const { code, newCode, days } = req.body;
  if (code !== ADMIN_CODE) return res.status(403).send("Доступ запрещен");

  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + parseInt(days));
  codes[newCode] = expiryDate.toISOString();
  fs.writeFileSync(codesPath, JSON.stringify(codes, null, 2));
  res.redirect(`/admin?code=${ADMIN_CODE}`);
});

// Удаление кода
app.post("/admin/deleteCode", (req, res) => {
  const { code, delCode } = req.body;
  if (code !== ADMIN_CODE) return res.status(403).send("Доступ запрещен");

  delete codes[delCode];
  fs.writeFileSync(codesPath, JSON.stringify(codes, null, 2));
  res.redirect(`/admin?code=${ADMIN_CODE}`);
});

// Список проектов
app.get("/admin/projects", checkAdmin, (req, res) => {
  const folders = fs.readdirSync(CLIENTS_DIR).filter(f => fs.statSync(path.join(CLIENTS_DIR, f)).isDirectory());
  const projects = folders.map(f => ({
    folder: f,
    url: `/clients/${f}/index.html`,
    qr: `/clients/${f}/qr.png`,
    photo: `/clients/${f}/final_with_qr.jpg`
  }));
  res.json(projects);
});

// Удаление проекта
app.post("/admin/deleteProject", checkAdmin, (req, res) => {
  const { folder } = req.body;
  const projectPath = path.join(CLIENTS_DIR, folder);
  if (fs.existsSync(projectPath)) {
    fs.rmSync(projectPath, { recursive: true, force: true });
    res.sendStatus(200);
  } else {
    res.status(404).send("Проект не найден");
  }
});

// === Запуск сервера ===
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});