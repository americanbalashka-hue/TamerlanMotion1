import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import Jimp from "jimp";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";   // ✅ добавлено

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENTS_DIR = path.join(process.cwd(), "clients");
if (!fs.existsSync(CLIENTS_DIR)) fs.mkdirSync(CLIENTS_DIR);

// Настройка multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ✅ Кэширование статики (ускоряет загрузку сайта клиентом)
app.use(express.static("clients", { maxAge: "30d", immutable: true }));

// Octokit для GitHub
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Загружаем коды подписки
const codesPath = path.join(process.cwd(), "codes.json");
let codes = {};
if (fs.existsSync(codesPath)) {
  codes = JSON.parse(fs.readFileSync(codesPath, "utf-8"));
}

// 🔥 Функция: сжатие + слияние видео с фото до ≤5 МБ
async function compressAndMergeVideo(photoPath, rawVideoPath, compressedVideoPath) {
  let targetBitrate = 1000; // стартовый битрейт (кбит/с)

  while (true) {
    await new Promise((resolve, reject) => {
      ffmpeg(rawVideoPath)
        .input(photoPath) // фото как подложка
        .complexFilter([
          "[1:v]scale=640:-1[vid];[0:v][vid]overlay=(W-w)/2:(H-h)/2"
        ])
        .outputOptions([
          "-c:v libx264",
          "-preset veryfast",
          "-tune film",
          "-movflags +faststart",
          `-b:v ${targetBitrate}k`,
          "-maxrate " + targetBitrate + "k",
          "-bufsize " + targetBitrate * 2 + "k",
          "-c:a aac",
          "-b:a 128k"
        ])
        .on("end", resolve)
        .on("error", reject)
        .save(compressedVideoPath);
    });

    // проверка размера
    const stats = fs.statSync(compressedVideoPath);
    const sizeMB = stats.size / (1024 * 1024);

    if (sizeMB <= 5) break; // ✅ если ≤5 МБ → готово
    targetBitrate = Math.max(300, targetBitrate - 200); // уменьшаем битрейт
    console.log(`⚠️ Видео ${sizeMB.toFixed(2)} МБ. Пробуем битрейт ${targetBitrate}k...`);
  }

  console.log("✅ Видео успешно сжато и слито с фото:", compressedVideoPath);
}

// Форма загрузки
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>TamerlanMotion 1.0 - Загрузка AR-файлов</title>
<style>
body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background:#f4f6f8; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
.upload-container { background:#fff; padding:40px 30px; border-radius:12px; box-shadow:0 8px 20px rgba(0,0,0,0.1); width:420px; }
h2 { text-align:center; color:#2c3e50; margin-bottom:25px; font-weight:600; }
input[type="file"], input[type="text"] { width:100%; margin:10px 0; padding:12px; font-size:14px; border-radius:6px; border:1px solid #d1d5da; }
button { width:100%; margin-top:12px; padding:14px; background-color:#2c3e50; color:#fff; font-size:16px; border:none; border-radius:8px; cursor:pointer; font-weight:500; transition: background 0.3s ease; }
button:hover { background-color:#1a252f; }
.instruction { font-size:14px; color:#34495e; line-height:1.6; margin-top:15px; }
.instruction p { margin:6px 0; }
#progressBar { display:none; width:100%; background:#e0e0e0; border-radius:6px; margin-top:15px; height:20px; }
#progressBar div { height:100%; width:0%; background:#2c3e50; text-align:center; color:white; line-height:20px; font-size:12px; transition: width 0.3s; }
#status { margin-top:10px; text-align:center; font-size:14px; color:#34495e; }
</style>
</head>
<body>
<div class="upload-container">
<h2>TamerlanMotion 1.0</h2>

<button id="mindButton" onclick="window.open('https://hiukim.github.io/mind-ar-js-doc/tools/compile/', '_blank')">
Открыть генератор .mind
</button>

<div class="instruction">
<p><strong>Шаг 1:</strong> Получите секретный код для загрузки.</p>
<p><strong>Шаг 2:</strong> Нажмите кнопку выше, чтобы открыть генератор .mind и создать маркер.</p>
<p><strong>Шаг 3:</strong> Скачайте файл <code>.mind</code>.</p>
<p><strong>Шаг 4:</strong> Введите секретный код и загрузите <code>.mind</code>, фото и видео в форму ниже.</p>
</div>

<form id="uploadForm" enctype="multipart/form-data">
<input type="text" name="secretCode" placeholder="Введите секретный код" required>
<input type="file" name="photo" accept="image/jpeg" required>
<input type="file" name="video" accept="video/mp4" required>
<input type="file" name="mind" accept=".mind" required>
<button type="submit">Загрузить</button>
</form>

<div id="progressBar"><div></div></div>
<div id="status"></div>
</div>

<script>
const form = document.getElementById('uploadForm');
const progressBar = document.getElementById('progressBar');
const progress = progressBar.firstElementChild;
const status = document.getElementById('status');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const files = new FormData(form);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload', true);

  xhr.upload.onprogress = (event) => {
    if(event.lengthComputable) {
      const percent = Math.round((event.loaded / event.total) * 100);
      progress.style.width = percent + '%';
      progress.textContent = percent + '%';
      progressBar.style.display = 'block';
    }
  };

  xhr.onload = () => {
    if(xhr.status === 200) {
      status.innerHTML = xhr.responseText;
      progress.style.width = '100%';
      progress.textContent = 'Готово!';
    } else {
      status.innerHTML = '<p style="color:red;">' + xhr.responseText + '</p>';
    }
  };

  xhr.send(files);
});
</script>
</body>
</html>
  `);
});

// Обработка загрузки файлов
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
      const code = req.body.secretCode || (req.files.secretCode && req.files.secretCode[0].buffer.toString());

      // Проверка кода
      if(!code || !codes[code]) {
        return res.status(403).send("Неверный или просроченный секретный код");
      }

      const expiry = new Date(codes[code]);
      if(expiry < new Date()) {
        return res.status(403).send("Срок действия секретного кода истёк");
      }

      const timestamp = Date.now();
      const clientFolder = path.join(CLIENTS_DIR, `client${timestamp}`);
      fs.mkdirSync(clientFolder);

      const { photo, video, mind } = req.files;

      const photoPath = path.join(clientFolder, photo[0].originalname);
      const rawVideoPath = path.join(clientFolder, "raw_" + video[0].originalname);
      const compressedVideoPath = path.join(clientFolder, video[0].originalname);
      const mindPath = path.join(clientFolder, mind[0].originalname);

      fs.writeFileSync(photoPath, photo[0].buffer);
      fs.writeFileSync(rawVideoPath, video[0].buffer);
      fs.writeFileSync(mindPath, mind[0].buffer);

      // ✅ Новый вызов
      await compressAndMergeVideo(photoPath, rawVideoPath, compressedVideoPath);

      fs.unlinkSync(rawVideoPath); // удаляем оригинал после сжатия

      // Генерация HTML
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
#container { position:fixed; top:0; left:0; width:100vw; height:100vh; display:flex; justify-content:center; align-items:center; background:black; }
#startButton { position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); padding:20px 40px; font-size:18px; background:#1e90ff; color:white; border:none; border-radius:8px; cursor:pointer; z-index:10; }
a-scene { width:100%; height:100%; }
</style>
</head>
<body>
<div id="container">
<button id="startButton">Нажмите, чтобы включить камеру</button>
<a-scene mindar-image="imageTargetSrc: ${mind[0].originalname};" embedded color-space="sRGB" renderer="antialias: true, precision: mediump" vr-mode-ui="enabled: false" device-orientation-permission-ui="enabled: false">
<a-assets>
<video id="video1" src="${video[0].originalname}" preload="metadata" playsinline webkit-playsinline muted></video>
</a-assets>
<a-camera position="0 0 0" look-controls="enabled: false"></a-camera>
<a-entity mindar-image-target="targetIndex: 0">
<a-video id="videoPlane" src="#video1"></a-video>
</a-entity>
</a-scene>
</div>
<script>
const button = document.getElementById('startButton');
const videoEl = document.getElementById('video1');
const videoPlane = document.getElementById('videoPlane');
const targetEntity = document.querySelector('[mindar-image-target]');
let isPlaying = false;
button.addEventListener('click', async () => {
  try { videoEl.muted=true; await videoEl.play(); videoEl.pause(); videoEl.currentTime=0; button.style.display='none'; }
  catch(err) { console.error(err); alert('Не удалось включить камеру'); }
});
videoEl.addEventListener('loadedmetadata', () => {
  const aspect = videoEl.videoWidth / videoEl.videoHeight;
  const baseWidth = 1; const baseHeight = baseWidth / aspect;
  videoPlane.setAttribute('width', baseWidth);
  videoPlane.setAttribute('height', baseHeight);
});
targetEntity.addEventListener('targetFound', () => { if(!isPlaying){ videoEl.muted=false; videoEl.currentTime=0; videoEl.play(); isPlaying=true; }});
targetEntity.addEventListener('targetLost', () => { videoEl.pause(); videoEl.currentTime=0; isPlaying=false; });
</script>
</body>
</html>
`;
      fs.writeFileSync(path.join(clientFolder, "index.html"), htmlContent);

      // QR-код
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
      for(const file of files) {
        const content = fs.readFileSync(path.join(clientFolder, file), { encoding: "base64" });
        await octokit.repos.createOrUpdateFileContents({
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO,
          path: `clients/client${timestamp}/${file}`,
          message: `Добавлены файлы для client${timestamp}`,
          content,
        });
      }

      res.send(`
<h3>Готово ✅</h3>
<p>Ссылка для клиента: <a href="${clientUrl}" target="_blank">${clientUrl}</a></p>
<p>QR-код встроен в фото (скачайте ниже):</p>
<a href="/client${timestamp}/final_with_qr.jpg" download>
<img src="/client${timestamp}/final_with_qr.jpg" width="400">
</a>
`);
    } catch(err) {
      console.error(err);
      res.status(500).send("Ошибка при обработке ❌");
    }
  }
);

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));