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

// Upload page
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "upload.html"));
});

// Upload handler
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

      // Проверка кода
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

      // Подставляем файлы в шаблон
      let template = fs.readFileSync("template.html", "utf-8");
      template = template
        .replace("{{MIND_FILE}}", mind[0].originalname)
        .replace("{{VIDEO_FILE}}", video[0].originalname);

      fs.writeFileSync(path.join(clientFolder, "index.html"), template);

      // Генерация QR-кода
      const clientUrl = `https://${process.env.GITHUB_OWNER}.github.io/${process.env.GITHUB_REPO}/clients/client${timestamp}/index.html`;
      const qrPath = path.join(clientFolder, "qr.png");
      await QRCode.toFile(qrPath, clientUrl, { width: 200 });

      // QR на фото
      const image = await Jimp.read(photoPath);
      const qrImage = await Jimp.read(qrPath);
      qrImage.resize(200, 200);
      image.composite(qrImage, 10, image.bitmap.height - 210);
      const finalPhotoPath = path.join(clientFolder, "final_with_qr.jpg");
      await image.writeAsync(finalPhotoPath);

      // Публикация на GitHub Pages
      const files = fs.readdirSync(clientFolder);
      for (const file of files) {
        const content = fs.readFileSync(path.join(clientFolder, file), {
          encoding: "base64",
        });
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

app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);