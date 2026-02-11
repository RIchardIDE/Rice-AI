import sys
import json
import numpy as np
import os
from tensorflow.keras.models import load_model
from tensorflow.keras.preprocessing import image

sys.stdout.reconfigure(encoding='utf-8')
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3' 

try:
    # 1. รับ path รูปภาพจาก Node.js
    img_path = sys.argv[1]

    # 2. โหลดโมเดล (ใช้ไฟล์ .h5 )
    model = load_model("ai_model/keras_model.h5", compile=False)
    with open("ai_model/labels.txt", "r", encoding="utf-8") as f:
        class_names = f.readlines()

    # 3. เตรียมรูป
    img = image.load_img(img_path, target_size=(224, 224))
    img_array = image.img_to_array(img)
    img_array = (img_array.astype(np.float32) / 127.5) - 1.0
    data = np.expand_dims(img_array, axis=0)

    # 4. วิเคราะห์
    prediction = model.predict(data, verbose=0)
    index = np.argmax(prediction)
    class_name = class_names[index].strip()
    confidence_score = float(prediction[0][index])

    disease_result = class_name[2:] if class_name[0].isdigit() else class_name
    confidence_percent = f"{confidence_score * 100:.2f}%"

    # 5. ส่งผลลัพธ์กลับไปให้ Node.js (เป็น JSON)
    result = {
        "disease": disease_result,
        "confidence": confidence_percent
    }
    print(json.dumps(result)) 

except Exception as e:

    print(json.dumps({"error": str(e)}))