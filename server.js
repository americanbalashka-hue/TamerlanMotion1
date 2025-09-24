// server.js
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

// Multer setup
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static("clients"));

// Octokit for GitHub
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Load secret codes
const codesPath = path.join(process.cwd(), "codes.json");
let codes = {};
if (fs.existsSync(codesPath)) {
  codes = JSON.parse(fs.readFileSync(codesPath, "utf-8"));
}

// Serve upload page
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "upload.html"));
});

// Handle upload
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
      const code =
        req.body.secretCode ||
        (req.files.secretCode && req.files.secretCode[0].buffer.toString());

      // Check code
      if (!code || !codes[code]) {
        return res.status(403).send("Неверный или просроченный секретный код");
      }
      const expiry = new Date(codes[code]);
      if (expiry < new Date()) {
        return res.status(403).send("Срок действия секретного кода истёк");
      }

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

      // Generate AR HTML
      const htmlContent = `
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>AR Фото-видео</title>
<script src="https://aframe.io/releases/1.4.0/aframe.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js"></script>
<style>
body{margin:0;background:black;height:100vh;width:100vw;overflow:hidden;}
#container{position:fixed;top:0;left:0;width:100vw;height:100vh;display:flex;justify-content:center;align-items:center;background:black;}
#startButton{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px 40px;font-size:18px;background:#1e90ff;color:white;border:none;border-radius:8px;cursor:pointer;z-index:10;}
a-scene{width:100%;height:100%;}
</style>
</head>
<body>
<div id="container">
<button id="startButton">Нажмите, чтобы включить камеру</button>
<a-scene mindar-image="imageTargetSrc: ${mind[0].originalname};" embedded color-space="sRGB" renderer="colorManagement: true, physicallyCorrectLights" vr-mode-ui="enabled: false" device-orientation-permission-ui="enabled: false">
<a-assets>
<video id="video1" src="${video[0].originalname}" preload="auto" playsinline webkit-playsinline muted></video>
</a-assets>
<a-camera position="0 0 0" look-controls="enabled: false"></a-camera>
<a-entity mindar-image-target="targetIndex: 0">
<a-video id="videoPlane" src="#video1" material="opacity: 0.65"></a-video>
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

      // Generate QR code
      const clientUrl = `${req.protocol}://${req.get("host")}/client${timestamp}/index.html`;
      const qrPath = path.join(clientFolder, "qr.png");
      await QRCode.toFile(qrPath, clientUrl, { width: 200 });

      // Overlay QR on photo
      const image = await Jimp.read(photoPath);
      const qrImage = await Jimp.read(qrPath);
      qrImage.resize(200, 200);
      image.composite(qrImage, 10, image.bitmap.height - 210);
      const finalPhotoPath = path.join(clientFolder, "final_with_qr.jpg");
      await image.writeAsync(finalPhotoPath);

      // Upload to GitHub
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

      res.send(`
<h3>Готово ✅</h3>
<p>Ссылка для клиента: <a href="${clientUrl}" target="_blank">${clientUrl}</a></p>
<p>QR-код встроен в фото:</p>
<a href="/client${timestamp}/final_with_qr.jpg" download>
<img src="/client${timestamp}/final_with_qr.jpg" width="400">
</a>
`);
    } catch (err) {
      console.error(err);
      res.status(500).send("Ошибка при обработке ❌");
    }
  }
);

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));