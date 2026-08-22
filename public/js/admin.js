document.getElementById('broadcastForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append('message', document.getElementById('broadcastMessage').value);
    formData.append('imageUrl', document.getElementById('imageUrl').value);
    formData.append('adminSecret', document.getElementById('adminSecret').value);
    
    const fileInput = document.getElementById('imageFile');
    if (fileInput.files[0]) {
        formData.append('imageFile', fileInput.files[0]);
    }

    const res = await fetch('/api/admin/broadcast', { method: 'POST', body: formData });
    const data = await res.json();
    alert(data.message);
});

document.getElementById('balanceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
        username: document.getElementById('targetUsername').value,
        amount: parseFloat(document.getElementById('adjustAmount').value),
        reason: document.getElementById('adjustReason').value,
        adminSecret: document.getElementById('balanceAdminSecret').value
    };

    const res = await fetch('/api/admin/update-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    alert(data.message || `Balance Updated! New Balance: ${data.newBalance}`);
});