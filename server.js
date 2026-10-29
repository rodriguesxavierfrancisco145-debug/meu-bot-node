const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('MOZ CONECTED Bot está online e a funcionar 24/7! 🚀');
});

app.listen(PORT, () => {
    console.log(`Servidor HTTP de suporte a correr na porta ${PORT}`);
});

require('./index.js');
