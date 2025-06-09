import express from "express";
import cors from "cors";
import { OpenAI } from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/chat", async (req, res) => {
  const { message } = req.body;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "당신은 한국어로 환자 항공이송 상담을 도와주는 전문가입니다." },
      { role: "user", content: message }
    ],
  });

  res.json({ reply: response.choices[0].message.content });
});

app.listen(3000, () => console.log("Server running"));
