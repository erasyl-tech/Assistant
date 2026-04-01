const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Файл жүктеу
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Қалталарды тексеру және жасау
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// JSON файлдарын инициализациялау
if (!fs.existsSync('./data/tests.json')) {
    fs.writeFileSync('./data/tests.json', '[]');
}
if (!fs.existsSync('./data/sessions.json')) {
    fs.writeFileSync('./data/sessions.json', '{}');
}

// ============ АДМИН БЕТІН ҚОРҒАУ МИДЛВЕРІ ============
// Админ бетін қорғау мидлвері
app.get('/admin-panel.html', (req, res) => {
    // Бұл файлды қорғау қажет емес, өйткені JavaScript арқылы тексеріледі
    res.sendFile(path.join(__dirname, 'public', 'admin-panel.html'));
});

// Басқа админ беттеріне тікелей кіруді блоктау
app.use((req, res, next) => {
    if (req.path === '/admin-panel.html') {
        // Рұқсат
        next();
    } else if (req.path.includes('admin') && req.path !== '/admin-panel.html') {
        // Ескі admin.html-ге кіруді блоктау
        res.redirect('/');
    } else {
        next();
    }
});
// ============ АДМИН БЕТІН ҚОРҒАУ МИДЛВЕРІ СОҢЫ ============

// Қауіпсіз оқу функциялары
function readTests() {
    try {
        const data = fs.readFileSync('./data/tests.json', 'utf-8');
        if (!data || data.trim() === '') {
            return [];
        }
        return JSON.parse(data);
    } catch (error) {
        console.error('tests.json оқу қатесі:', error.message);
        return [];
    }
}

function saveTests(tests) {
    try {
        fs.writeFileSync('./data/tests.json', JSON.stringify(tests, null, 2));
    } catch (error) {
        console.error('tests.json сақтау қатесі:', error.message);
    }
}

function readSessions() {
    try {
        const data = fs.readFileSync('./data/sessions.json', 'utf-8');
        if (!data || data.trim() === '') {
            return {};
        }
        return JSON.parse(data);
    } catch (error) {
        console.error('sessions.json оқу қатесі:', error.message);
        return {};
    }
}

function saveSessions(sessions) {
    try {
        fs.writeFileSync('./data/sessions.json', JSON.stringify(sessions, null, 2));
    } catch (error) {
        console.error('sessions.json сақтау қатесі:', error.message);
    }
}

// Файлды парсинг (формат: ? сұрақ \n + жауап \n - қате)
function parseTestFile(content) {
    const lines = content.split('\n');
    const questions = [];
    let currentQuestion = null;
    
    for (let line of lines) {
        line = line.trim();
        if (line === '') continue;
        
        if (line.startsWith('?')) {
            if (currentQuestion) questions.push(currentQuestion);
            currentQuestion = {
                text: line.substring(1).trim(),
                options: [],
                correct: 0
            };
        } else if (line.startsWith('+') && currentQuestion) {
            currentQuestion.options.push(line.substring(1).trim());
            currentQuestion.correct = currentQuestion.options.length - 1;
        } else if (line.startsWith('-') && currentQuestion) {
            currentQuestion.options.push(line.substring(1).trim());
        }
    }
    if (currentQuestion) questions.push(currentQuestion);
    return questions;
}

// API: Тест жүктеу
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        const filePath = path.join(__dirname, 'uploads', req.file.filename);
        const content = fs.readFileSync(filePath, 'utf-8');
        const questions = parseTestFile(content);
        
        if (questions.length === 0) {
            return res.status(400).json({ success: false, error: 'Файлда сұрақ табылмады' });
        }
        
        const testId = Date.now().toString();
        const newTest = {
            id: testId,
            name: req.body.name || req.file.originalname.replace('.txt', ''),
            questions: questions,
            createdAt: new Date().toISOString()
        };
        
        const tests = readTests();
        tests.push(newTest);
        saveTests(tests);
        fs.unlinkSync(filePath);
        
        res.json({ success: true, testId: testId, questionCount: questions.length });
    } catch (error) {
        console.error('Жүктеу қатесі:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: Барлық тесттерді алу
app.get('/api/tests', (req, res) => {
    const tests = readTests();
    res.json(tests.map(t => ({ id: t.id, name: t.name, questionCount: t.questions.length })));
});

// ============ SOCKET.IO ============
let activeSessions = {};

// 6 цифрлы код генерациялау
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket) => {
    console.log('Қосылды:', socket.id);
    
    // Админ сессия бастау
    socket.on('admin-create-session', (data) => {
        const { testId, settings } = data;
        const tests = readTests();
        const test = tests.find(t => t.id === testId);
        
        if (!test) {
            socket.emit('error', 'Тест табылмады');
            return;
        }
        
        const sessionCode = generateCode();
        
        // Сұрақтарды дайындау
        let questions = [...test.questions];
        
        // Сұрақтарды араластыру
        if (settings.shuffleQuestions === 'true' || settings.shuffleQuestions === true) {
            for (let i = questions.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [questions[i], questions[j]] = [questions[j], questions[i]];
            }
        }
        
        // Жауаптарды араластыру
        if (settings.shuffleAnswers === 'true' || settings.shuffleAnswers === true) {
            questions = questions.map(q => {
                const options = [...q.options];
                const correctText = options[q.correct];
                for (let i = options.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [options[i], options[j]] = [options[j], options[i]];
                }
                const newCorrectIndex = options.indexOf(correctText);
                return { ...q, options: options, correct: newCorrectIndex };
            });
        }
        
        // Сұрақтарды таңдау
        let selectedQuestions = [];
        const qCount = test.questions.length;
        
        if (settings.questionRange) {
            const [start, end] = settings.questionRange.split('-').map(Number);
            selectedQuestions = questions.slice(start - 1, end);
        } else if (settings.randomCount) {
            const count = Math.min(parseInt(settings.randomCount), qCount);
            const shuffled = [...questions];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            selectedQuestions = shuffled.slice(0, count);
        } else {
            selectedQuestions = questions;
        }
        
        activeSessions[sessionCode] = {
            adminSocketId: socket.id,
            testId: testId,
            testName: test.name,
            settings: settings,
            questions: selectedQuestions,
            totalQuestions: selectedQuestions.length,
            participants: [],
            started: false,
            results: []
        };
        
        socket.join(sessionCode);
        socket.emit('session-created', { sessionCode, totalQuestions: selectedQuestions.length });
        
        const sessions = readSessions();
        sessions[sessionCode] = {
            testId, testName: test.name, settings, questions: selectedQuestions,
            participants: [], started: false, createdAt: new Date().toISOString()
        };
        saveSessions(sessions);
    });
    
    // Қолданушының қосылуы
    socket.on('participant-join', (data) => {
        const { sessionCode, name } = data;
        const session = activeSessions[sessionCode];
        
        if (!session) {
            socket.emit('join-error', 'Код жарамсыз');
            return;
        }
        
        if (session.started) {
            socket.emit('join-error', 'Тест басталып кеткен');
            return;
        }
        
        const participant = {
            socketId: socket.id,
            name: name,
            answers: new Array(session.totalQuestions).fill(null),
            startTime: null,
            endTime: null,
            score: null,
            currentIndex: 0
        };
        
        session.participants.push(participant);
        socket.join(sessionCode);
        socket.participantData = { sessionCode, name: name };
        
        io.to(sessionCode).emit('participants-update', 
            session.participants.map(p => ({ name: p.name, answered: p.answers.filter(a => a !== null).length }))
        );
        
        socket.emit('join-success', { 
            sessionCode, 
            totalQuestions: session.totalQuestions,
            testName: session.testName
        });
    });
    
    // Қолданушының сұрақтарын алу
    socket.on('get-questions', (data) => {
        const session = activeSessions[data.sessionCode];
        if (session && session.started) {
            const participant = session.participants.find(p => p.socketId === socket.id);
            if (participant) {
                socket.emit('questions-loaded', {
                    questions: session.questions.map(q => ({ text: q.text, options: q.options })),
                    totalQuestions: session.totalQuestions,
                    testName: session.testName
                });
            }
        }
    });
    
    // Админ тестті бастау
    socket.on('admin-start-test', (data) => {
        const { sessionCode } = data;
        const session = activeSessions[sessionCode];
        
        if (session && session.adminSocketId === socket.id) {
            session.started = true;
            const startTime = Date.now();
            
            io.to(sessionCode).emit('test-started', { startTime });
            
            session.participants.forEach(p => {
                p.startTime = startTime;
            });
        }
    });
    
    // Жауап жіберу
    socket.on('submit-answer', (data) => {
        const { sessionCode, questionIndex, answerIndex } = data;
        const session = activeSessions[sessionCode];
        
        if (session && session.started) {
            const participant = session.participants.find(p => p.socketId === socket.id);
            if (participant) {
                participant.answers[questionIndex] = answerIndex;
                
                const answeredCount = participant.answers.filter(a => a !== null).length;
                io.to(sessionCode).emit('participant-progress', {
                    name: participant.name,
                    answered: answeredCount,
                    total: session.totalQuestions,
                    currentIndex: questionIndex
                });
            }
        }
    });
    
    // Тестті аяқтау
    socket.on('finish-test', (data) => {
        const { sessionCode } = data;
        const session = activeSessions[sessionCode];
        
        if (session) {
            const participant = session.participants.find(p => p.socketId === socket.id);
            if (participant && !participant.endTime) {
                participant.endTime = Date.now();
                
                let correctCount = 0;
                participant.answers.forEach((answer, idx) => {
                    if (answer !== null && answer === session.questions[idx].correct) {
                        correctCount++;
                    }
                });
                participant.score = Math.round((correctCount / session.totalQuestions) * 100);
                
                const timeSpent = Math.floor((participant.endTime - participant.startTime) / 1000);
                
                io.to(sessionCode).emit('participant-finished', {
                    name: participant.name,
                    score: participant.score,
                    correctCount: correctCount,
                    totalQuestions: session.totalQuestions,
                    timeSpent: timeSpent
                });
                
                socket.emit('test-result', {
                    score: participant.score,
                    correctCount: correctCount,
                    totalQuestions: session.totalQuestions,
                    timeSpent: timeSpent,
                    answers: participant.answers.map((ans, idx) => ({
                        isCorrect: ans === session.questions[idx].correct,
                        userAnswer: ans !== null ? session.questions[idx].options[ans] : null,
                        correctAnswer: session.questions[idx].options[session.questions[idx].correct]
                    }))
                });
                
                checkAllFinished(sessionCode);
            }
        }
    });
    
    function checkAllFinished(sessionCode) {
        const session = activeSessions[sessionCode];
        if (!session) return;
        
        const allFinished = session.participants.every(p => p.endTime !== null);
        if (allFinished && session.participants.length > 0) {
            const ranking = [...session.participants]
                .map(p => ({
                    name: p.name,
                    score: p.score,
                    timeSpent: Math.floor((p.endTime - p.startTime) / 1000),
                    correctCount: p.answers.filter((a, idx) => a === session.questions[idx].correct).length
                }))
                .sort((a, b) => {
                    if (a.score !== b.score) return b.score - a.score;
                    return a.timeSpent - b.timeSpent;
                });
            
            io.to(sessionCode).emit('all-finished', { ranking });
        }
    }
    
    socket.on('disconnect', () => {
        console.log('Ажырады:', socket.id);
        
        for (const [code, session] of Object.entries(activeSessions)) {
            const participantIndex = session.participants.findIndex(p => p.socketId === socket.id);
            if (participantIndex !== -1) {
                session.participants.splice(participantIndex, 1);
                io.to(code).emit('participants-update', 
                    session.participants.map(p => ({ name: p.name, answered: p.answers.filter(a => a !== null).length }))
                );
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Сервер http://localhost:${PORT} портында істеді`);
    console.log(`⚠️ Ескерту: /admin.html деген бет өшірілді, /admin-panel.html қолданыңыз`);
});