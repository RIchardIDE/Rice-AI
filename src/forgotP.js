const API_URL = 'http://localhost:3000';

const btnPhone = document.getElementById('btn-phone');
const btnEmail = document.getElementById('btn-email');
const inputLabel = document.getElementById('input-label');
const inputField = document.getElementById('input-field');
const inputIcon = document.getElementById('input-icon');
const submitBtn = document.getElementById('submit-btn');
const helperText = document.getElementById('helper-text');

let currentMethod = 'phone';


window.toggleMethod = (method) => {
    currentMethod = method;
    inputField.value = ''; 

    if (method === 'phone') {
        btnPhone.className = "w-1/2 bg-white text-gray-800 py-2 rounded-lg shadow-sm font-bold text-sm transition duration-200";
        btnEmail.className = "w-1/2 text-gray-500 py-2 rounded-lg font-medium text-sm hover:bg-gray-200 transition duration-200";

        inputLabel.innerText = "เบอร์โทรศัพท์มือถือ";
        inputField.placeholder = "08X-XXX-XXXX";
        inputField.type = "tel";
        inputIcon.className = "fa-solid fa-phone";
        submitBtn.innerText = "รับรหัส OTP";
        helperText.innerText = "ระบบจะส่งรหัส OTP ไปยังเบอร์นี้";
    } else {
        btnEmail.className = "w-1/2 bg-white text-gray-800 py-2 rounded-lg shadow-sm font-bold text-sm transition duration-200";
        btnPhone.className = "w-1/2 text-gray-500 py-2 rounded-lg font-medium text-sm hover:bg-gray-200 transition duration-200";

        inputLabel.innerText = "อีเมล";
        inputField.placeholder = "example@email.com";
        inputField.type = "email";
        inputIcon.className = "fa-solid fa-envelope";
        submitBtn.innerText = "ส่งรหัส OTP ทางอีเมล";
        helperText.innerText = "ระบบจะส่งรหัส OTP ไปยังอีเมลนี้";
    }
};

// ฟังก์ชันกดปุ่มส่ง
submitBtn.addEventListener('click', async () => {
    const contactValue = inputField.value.trim();


    if (!contactValue) {
        alert(`กรุณากรอก${currentMethod === 'phone' ? 'เบอร์โทรศัพท์' : 'อีเมล'}`);
        return;
    }

    if (currentMethod === 'phone') {

        const phoneRegex = /^[0-9]{10}$/;
        if (!phoneRegex.test(contactValue.replace(/-/g, ''))) {
            alert('เบอร์โทรศัพท์ไม่ถูกต้อง (ต้องเป็นตัวเลข 10 หลัก)');
            return;
        }
    } else {

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(contactValue)) {
            alert('รูปแบบอีเมลไม่ถูกต้อง');
            return;
        }
    }


    const originalText = submitBtn.innerText;
    submitBtn.innerText = "กำลังดำเนินการ...";
    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-50', 'cursor-not-allowed');

    try {
        const response = await fetch(`${API_URL}/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contact: contactValue,
                method: currentMethod 
            })
        });

        const data = await response.json();

        if (data.success) {

            localStorage.setItem('reset_contact', contactValue);


            localStorage.setItem('reset_method', currentMethod);

            alert(data.message);


            if (currentMethod === 'phone') {
                window.location.href = 'verify_otp.html';
            } else {
                window.location.href = 'reset_password.html';
            }
        }

     else {
        alert(data.message || 'เกิดข้อผิดพลาดในการส่งข้อมูล');
        resetButton(originalText);
    }

} catch (error) {
    console.error('Error:', error);
    alert('ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้');
    resetButton(originalText);
}
});

function resetButton(text) {
    submitBtn.innerText = text;
    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
}