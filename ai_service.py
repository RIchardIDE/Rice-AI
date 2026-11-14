import os
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image
from tensorflow.keras.models import load_model


BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "ai_model" / "keras_model.h5"
LABELS_PATH = BASE_DIR / "ai_model" / "labels.txt"
model = None
class_names = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, class_names
    model = load_model(MODEL_PATH, compile=False)
    class_names = LABELS_PATH.read_text(encoding="utf-8").splitlines()
    print("AI model loaded successfully", flush=True)
    yield
    model = None


app = FastAPI(title="Rice AI inference service", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": model is not None}


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    if file.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=400, detail="รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP")
    if model is None:
        raise HTTPException(status_code=503, detail="AI model ยังโหลดไม่เสร็จ")

    try:
        raw_image = await file.read()
        img = Image.open(BytesIO(raw_image)).convert("RGB").resize((224, 224))
        img_array = np.asarray(img, dtype=np.float32)
        data = np.expand_dims((img_array / 127.5) - 1.0, axis=0)

        prediction = model.predict(data, verbose=0)
        index = int(np.argmax(prediction))
        class_name = class_names[index].strip()
        disease = class_name[2:] if class_name[:1].isdigit() else class_name
        confidence = float(prediction[0][index]) * 100

        return {"disease": disease, "confidence": f"{confidence:.2f}%"}
    except Exception as error:
        print(f"Prediction error: {error}", flush=True)
        raise HTTPException(status_code=500, detail="ไม่สามารถประมวลผลรูปภาพได้") from error
