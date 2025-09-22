import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import Jimp from "jimp";
import { Octokit } from "@octokit/rest";

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENTS_DIR = path.join(process.cwd(), "clients");
if (!fs.existsSync(CLIENTS_DIR)) fs.mkdirSync(CLIENTS_DIR);

// Статика через /clients
app.use("/clients", express.static(CLIENTS_DIR));

// Настройка multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Octokit для GitHub
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Форма загрузки
app.get("/", (req, res) => {
  res.send(`
    <h2>Загрузка AR-файлов</h2>
    <form action="/upload" method="post" enctype="multipart/form-data">
      <p>Фото (jpg): <input type="file" name="photo" accept="image/jpeg" required></p>
      <p>Видео (mp4): <input type="file" name="video" accept="video/mp4" required></p>
      <p>Маркер (mind): <input type="file" name="mind" accept=".mind" required></p>
      <button type="submit">Загрузить</button>
    </form>
  `);
});

// Обработка загрузки
app.post(
  "/upload",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "video", maxCount: 1 },
    { name: "mind", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
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

      // Создание index.html с iOS/Android совместимостью
      const htmlContent = `
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>AR Фото-видео</title>
<script src="https://aframe.io/releases/1.4.0/aframe.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js"></script>
<style>
  body { margin:0; background:black; height:100vh; width:100vw; overflow:hidden; }
  #container { width:100vw; height:100vh; }
</style>
</head>
<body>
<div id="container">
  <a-scene mindar-image="imageTargetSrc: ${mind[0].originalname};" embedded>
    <a-assets>
      <video id="video1" src="${video[0].originalname}" preload="auto" playsinline webkit-playsinline muted></video>
    </a-assets>
    <a-camera position="0 0 0" look-controls="enabled: false"></a-camera>
    <a-entity mindar-image-target="targetIndex: 0">
      <a-video id="videoPlane" src="#video1"></a-video>
    </a-entity>
  </a-scene>
</div>

<script>
  const videoEl = document.getElementById('video1');
  const videoPlane = document.getElementById('videoPlane');
  const targetEntity = document.querySelector('[mindar-image-target]');
  let isPlaying = false;

  videoEl.addEventListener('loadedmetadata', () => {
    const aspect = videoEl.videoWidth / videoEl.videoHeight;
    const baseWidth = 1;
    const baseHeight = baseWidth / aspect;
    videoPlane.setAttribute('width', baseWidth);
    videoPlane.setAttribute('height', baseHeight);
  });

  targetEntity.addEventListener('targetFound', () => {
    if (!isPlaying) {
      videoEl.muted = false;
      videoEl.currentTime = 0;
      videoEl.play();
      isPlaying = true;
    }
  });

  targetEntity.addEventListener('targetLost', () => {
    videoEl.pause();
    videoEl.currentTime = 0;
    isPlaying = false;
  });
</script>

</body>
</html>
`;

      const htmlPath = path.join(clientFolder, "index.html");
      fs.writeFileSync(htmlPath, htmlContent);

      // Генерация QR-кода
      const clientUrl = `${req.protocol}://${req.get("host")}/clients/client${timestamp}/index.html`;
      const qrPath = path.join(clientFolder, "qr.png");
      await QRCode.toFile(qrPath, clientUrl, { width: 200 });

      // Вставка QR на фото
      const image = await Jimp.read(photoPath);
      const qrImage = await Jimp.read(qrPath);
      qrImage.resize(200, 200);
      image.composite(qrImage, 10, image.bitmap.height - 210);
      const finalPhotoPath = path.join(clientFolder, "final_with_qr.jpg");
      await image.writeAsync(finalPhotoPath);

      // Пуш в GitHub
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

      // Отдаём результат
      res.send(`
        <h3>Готово ✅</h3>
        <p>Ссылка для клиента: <a href="${clientUrl}" target="_blank">${clientUrl}</a></p>
        <p>QR-код встроен в фото (скачай ниже):</p>
        <a href="/clients/client${timestamp}/final_with_qr.jpg" download>
          <img src="/clients/client${timestamp}/final_with_qr.jpg" width="400">
        </a>
      `);

    } catch (err) {
      console.error(err);
      res.status(500).send("Ошибка при обработке ❌");
    }
  }
);

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));