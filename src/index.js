// QuizAI Server - Express.js Application
// Dependencies to install:
// npm i express hbs mongoose multer pdf-parse mammoth pptx2json @google/generative-ai dotenv nodemon express-session
// Run with: nodemon src/index.js

const express = require("express")
const app = express()
const path = require("path")
const hbs = require("hbs")
const multer = require("multer")
const fs = require("fs")
const pdfParse = require("pdf-parse")
const mammoth = require("mammoth")
const session = require('express-session');

// Fix for pptx2json import/usage
const { toJson } = require("pptx2json")

// Load environment variables from .env file
require('dotenv').config()

// Import database collections
const { 
    studentCollection, 
    teacherCollection, 
    lectureCollection, 
    quizCollection, 
    quizResultCollection, 
    explanationCacheCollection,
    classCollection,           // 🆕 NEW
    classStudentCollection     // 🆕 NEW
} = require("./mongodb")

// Google Gemini API setup
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai')
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

// Configuration
const PORT = 3000
const TEMP_UPLOAD_DIR = './temp_uploads'
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
const templatePath = path.join(__dirname, '../tempelates')

// Express configuration
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.set("view engine", "hbs")
app.set("views", templatePath)

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'a_very_secret_key_for_quizai',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 1 day
        httpOnly: true
    }
}));

// ==================== HANDLEBARS HELPERS REGISTRATION ====================
// Register Handlebars helpers
hbs.registerHelper('eq', function(a, b) {
    return a === b;
});

hbs.registerHelper('add', function(a, b) {
    return a + b;
});

hbs.registerHelper('getScoreClass', function(percentage) {
    if (percentage >= 90) return 'excellent';
    if (percentage >= 70) return 'good';
    if (percentage >= 50) return 'average';
    return 'poor';
});

hbs.registerHelper('formatTime', function(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
});

hbs.registerHelper('json', function(context) {
    return JSON.stringify(context);
});

// Enhanced ranking helper
hbs.registerHelper('getRankClass', function(index) {
    if (index === 0) return 'rank-1';
    if (index === 1) return 'rank-2';
    if (index === 2) return 'rank-3';
    return 'rank-other';
});

// Date formatting helper
hbs.registerHelper('formatDate', function(date) {
    return new Date(date).toLocaleDateString();
});

// Percentage formatting helper
hbs.registerHelper('toFixed', function(number, decimals) {
    return parseFloat(number).toFixed(decimals || 1);
});

console.log('✅ Handlebars helpers registered successfully!');

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login?message=Please login to access this page.');
    }
};

const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    } else {
        return res.status(401).json({ success: false, message: 'Authentication required' });
    }
};

// ==================== FILE UPLOAD CONFIGURATION ====================

// Configure multer for temporary file storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
            fs.mkdirSync(TEMP_UPLOAD_DIR)
        }
        cb(null, TEMP_UPLOAD_DIR)
    },
    filename: function (req, file, cb) {
        const uniqueName = Date.now() + '-' + file.originalname
        cb(null, uniqueName)
    }
})

// File type validation
const fileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]

    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true)
    } else {
        req.fileError = new Error('Invalid file type. Only PDF, PPT, PPTX, DOC, DOCX files are allowed.');
        cb(null, false);
    }
}

// Multer configuration
const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: fileFilter
})

// ==================== TEXT EXTRACTION FUNCTIONS ====================

async function extractTextFromPDF(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath)
        const data = await pdfParse(dataBuffer)
        console.log(`✅ PDF text extracted - Length: ${data.text.length} characters`)
        return data.text
    } catch (error) {
        console.error('❌ PDF extraction error:', error)
        throw new Error('Failed to extract text from PDF')
    }
}

async function extractTextFromWord(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath })
        console.log(`✅ Word text extracted - Length: ${result.value.length} characters`)
        return result.value
    } catch (error) {
        console.error('❌ Word extraction error:', error)
        throw new Error('Failed to extract text from Word document')
    }
}

async function extractTextFromPowerPoint(filePath) {
    try {
        const data = await toJson(filePath)
        let extractedText = ''

        if (data && data.slides) {
            data.slides.forEach((slide, index) => {
                extractedText += `\n--- Slide ${index + 1} ---\n`
                if (slide.content) {
                    slide.content.forEach(content => {
                        if (content.text) {
                            extractedText += content.text + '\n'
                        }
                    })
                }
            })
        }

        console.log(`✅ PowerPoint text extracted - Length: ${extractedText.length} characters`)
        return extractedText || "No text found in PowerPoint file"
    } catch (error) {
        console.error('❌ PowerPoint extraction error:', error)
        return "PowerPoint file uploaded successfully. Text extraction failed, but content is available."
    }
}

async function extractTextFromFile(filePath, mimetype) {
    console.log(`🔄 Starting text extraction for: ${mimetype}`)

    switch (mimetype) {
        case 'application/pdf':
            return await extractTextFromPDF(filePath)
        case 'application/msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return await extractTextFromWord(filePath)
        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
            return await extractTextFromPowerPoint(filePath)
        default:
            throw new Error('Unsupported file type')
    }
}

// ==================== UTILITY FUNCTIONS ====================

function getFileType(mimetype) {
    const typeMap = {
        'application/pdf': 'pdf',
        'application/msword': 'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-powerpoint': 'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    }
    return typeMap[mimetype] || 'unknown'
}

function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            console.log(`🗑️ Temporary file deleted: ${filePath}`)
        }
    } catch (error) {
        console.error('⚠️ Error cleaning up temporary file:', error)
    }
}

function cleanupTempFiles() {
    if (fs.existsSync(TEMP_UPLOAD_DIR)) {
        const files = fs.readdirSync(TEMP_UPLOAD_DIR)
        files.forEach(file => {
            const filePath = path.join(TEMP_UPLOAD_DIR, file)
            try {
                fs.unlinkSync(filePath)
                console.log(`🗑️ Cleaned up old temp file: ${file}`)
            } catch (error) {
                console.error(`⚠️ Could not clean up temp file ${file}:`, error)
            }
        })
    }
}

// ==================== AUTHENTICATION ROUTES ====================

app.get("/", (req, res) => {
    res.redirect("/login")
})

app.get("/login", (req, res) => {
    res.render("login", { message: req.query.message });
})

app.get("/signup", (req, res) => {
    res.render("signup")
})

app.post("/signup", async (req, res) => {
    try {
        const { userType, name, email, enrollment, password } = req.body

        if (userType === 'teacher') {
            const teacherData = { name, email, password }
            await teacherCollection.insertMany([teacherData])
            const newTeacher = await teacherCollection.findOne({ email: email });
            req.session.userId = newTeacher._id;
            req.session.userName = newTeacher.name;
            req.session.userType = userType;
            res.redirect(`/homeTeacher?userName=${encodeURIComponent(newTeacher.name)}`);
        } else {
            const studentData = { name, enrollment, password }
            await studentCollection.insertMany([studentData])
            const newStudent = await studentCollection.findOne({ enrollment: enrollment });
            req.session.userId = newStudent._id;
            req.session.userName = newStudent.name;
            req.session.userType = userType;
            res.redirect(`/homeStudent?userName=${encodeURIComponent(newStudent.name)}`);
        }
    } catch (error) {
        console.error('❌ Signup error:', error)
        res.send("Error during registration: " + error.message)
    }
})

app.post("/login", async (req, res) => {
    try {
        const { password, userType, email, enrollment } = req.body
        let user

        if (userType === 'teacher') {
            user = await teacherCollection.findOne({ email: email })
        } else {
            user = await studentCollection.findOne({ enrollment: enrollment })
        }

        if (user && user.password === password) {
            req.session.userId = user._id;
            req.session.userName = user.name;
            req.session.userType = userType;

            const redirectUrl = userType === 'teacher' ? '/homeTeacher' : '/homeStudent'
            res.redirect(`${redirectUrl}?userName=${encodeURIComponent(user.name)}`)
        } else {
            res.send("Wrong credentials")
        }
    } catch (error) {
        console.error('❌ Login error:', error)
        res.send("Login failed")
    }
})

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).send('Could not log out.');
        }
        res.redirect('/login?message=You have been logged out.');
    });
})

// ==================== DASHBOARD ROUTES ====================

// 📝 OPTIONAL: Add this to your /homeStudent route in index.js to handle class context

app.get("/homeStudent", isAuthenticated, async (req, res) => {
    try {
        // Get class context from query params (when redirected from student class route)
        const classContext = {
            classId: req.query.class || null,
            className: req.query.className || null,
            message: req.query.message || null
        };

        console.log('🎓 Student dashboard loaded with context:', classContext);

        res.render("homeStudent", {
            userType: req.session.userType || "student",
            userName: req.session.userName || "Student",
            classContext: classContext, // Pass context to template
            message: req.query.message
        });
    } catch (error) {
        console.error('❌ Error loading student dashboard:', error);
        res.render("homeStudent", {
            userType: req.session.userType || "student",
            userName: req.session.userName || "Student",
            error: 'Failed to load dashboard'
        });
    }
});

// 🔄 REPLACE your existing /homeTeacher route with this:
app.get("/homeTeacher", isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Not a teacher account.');
        }

        const teacherId = req.session.userId;

        // Get teacher's classes
        const classes = await classCollection.find({ 
            teacherId: teacherId, 
            isActive: true 
        }).sort({ createdAt: -1 }).lean();

        // Calculate overall stats
        const stats = {
            totalClasses: classes.length,
            totalStudents: classes.reduce((sum, cls) => sum + (cls.studentCount || 0), 0),
            totalLectures: classes.reduce((sum, cls) => sum + (cls.lectureCount || 0), 0),
            totalQuizzes: classes.reduce((sum, cls) => sum + (cls.quizCount || 0), 0)
        };

        // Format classes for display
        const formattedClasses = classes.map(classDoc => ({
            id: classDoc._id,
            name: classDoc.name,
            subject: classDoc.subject,
            description: classDoc.description,
            studentCount: classDoc.studentCount || 0,
            lectureCount: classDoc.lectureCount || 0,
            quizCount: classDoc.quizCount || 0,
            averageScore: classDoc.averageScore || 0,
            createdDate: classDoc.createdAt ? classDoc.createdAt.toLocaleDateString() : 'N/A'
        }));

        res.render("homeTeacher", {
            userType: req.session.userType || "teacher",
            userName: req.session.userName || "Teacher",
            ...stats,
            classes: formattedClasses,
            classCreated: req.query.classCreated === 'true',
            uploadError: req.query.uploadError === 'true',
            message: req.query.message,
            createdClassName: req.query.className
        });
    } catch (error) {
        console.error('❌ Error loading teacher dashboard:', error);
        res.status(500).render("homeTeacher", {
            userType: req.session.userType || "teacher",
            userName: req.session.userName || "Teacher",
            totalClasses: 0,
            totalStudents: 0,
            totalLectures: 0,
            totalQuizzes: 0,
            classes: [],
            uploadError: true,
            message: 'Failed to load dashboard: ' + error.message
        });
    }
});

// ==================== CLASS CRUD ROUTES ====================

// 📋 Get all classes for a teacher
app.get('/api/classes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const teacherId = req.session.userId;
        
        // Get teacher's classes with computed stats
        const classes = await classCollection.find({ 
            teacherId: teacherId, 
            isActive: true 
        })
        .sort({ createdAt: -1 })
        .lean();

        console.log(`📋 Found ${classes.length} classes for teacher ${req.session.userName}`);

        // Format classes for response
        const formattedClasses = classes.map(classDoc => ({
            id: classDoc._id,
            name: classDoc.name,
            subject: classDoc.subject,
            description: classDoc.description,
            studentCount: classDoc.studentCount || 0,
            lectureCount: classDoc.lectureCount || 0,
            quizCount: classDoc.quizCount || 0,
            averageScore: classDoc.averageScore || 0,
            createdAt: classDoc.createdAt,
            updatedAt: classDoc.updatedAt
        }));

        res.json({
            success: true,
            classes: formattedClasses,
            totalClasses: formattedClasses.length
        });

    } catch (error) {
        console.error('❌ Error fetching classes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch classes: ' + error.message
        });
    }
});

// ➕ Create new class
app.post('/api/classes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const { name, subject, description } = req.body;
        const teacherId = req.session.userId;
        const teacherName = req.session.userName;

        // Validate required fields
        if (!name || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Class name and subject are required.'
            });
        }

        // Check if class name already exists for this teacher
        const existingClass = await classCollection.findOne({
            teacherId: teacherId,
            name: name.trim(),
            isActive: true
        });

        if (existingClass) {
            return res.status(400).json({
                success: false,
                message: 'You already have a class with this name.'
            });
        }

        // Create new class
        const newClass = await classCollection.create({
            name: name.trim(),
            subject: subject.trim(),
            description: description?.trim() || '',
            teacherId: teacherId,
            teacherName: teacherName,
            studentCount: 0,
            lectureCount: 0,
            quizCount: 0,
            averageScore: 0
        });

        console.log(`✅ New class created: ${newClass.name} by ${teacherName}`);

        res.json({
            success: true,
            message: 'Class created successfully!',
            class: {
                id: newClass._id,
                name: newClass.name,
                subject: newClass.subject,
                description: newClass.description,
                studentCount: 0,
                lectureCount: 0,
                quizCount: 0,
                averageScore: 0,
                createdAt: newClass.createdAt
            }
        });

    } catch (error) {
        console.error('❌ Error creating class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create class: ' + error.message
        });
    }
});

// 📖 Get specific class details
app.get('/api/classes/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        res.json({
            success: true,
            class: {
                id: classDoc._id,
                name: classDoc.name,
                subject: classDoc.subject,
                description: classDoc.description,
                studentCount: classDoc.studentCount || 0,
                lectureCount: classDoc.lectureCount || 0,
                quizCount: classDoc.quizCount || 0,
                averageScore: classDoc.averageScore || 0,
                createdAt: classDoc.createdAt,
                updatedAt: classDoc.updatedAt
            }
        });

    } catch (error) {
        console.error('❌ Error fetching class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class: ' + error.message
        });
    }
});

// ✏️ Update class information
app.put('/api/classes/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { name, subject, description } = req.body;

        // Validate required fields
        if (!name || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Class name and subject are required.'
            });
        }

        // Check if class exists and belongs to teacher
        const existingClass = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!existingClass) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Update class
        const updatedClass = await classCollection.findByIdAndUpdate(
            classId,
            {
                name: name.trim(),
                subject: subject.trim(),
                description: description?.trim() || '',
                updatedAt: new Date()
            },
            { new: true }
        ).lean();

        console.log(`✅ Class updated: ${updatedClass.name}`);

        res.json({
            success: true,
            message: 'Class updated successfully!',
            class: {
                id: updatedClass._id,
                name: updatedClass.name,
                subject: updatedClass.subject,
                description: updatedClass.description,
                studentCount: updatedClass.studentCount || 0,
                lectureCount: updatedClass.lectureCount || 0,
                quizCount: updatedClass.quizCount || 0,
                averageScore: updatedClass.averageScore || 0,
                updatedAt: updatedClass.updatedAt
            }
        });

    } catch (error) {
        console.error('❌ Error updating class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update class: ' + error.message
        });
    }
});

// 🗄️ Archive/Delete class
app.delete('/api/classes/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Check if class exists and belongs to teacher
        const existingClass = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!existingClass) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Soft delete - mark as inactive
        await classCollection.findByIdAndUpdate(classId, {
            isActive: false,
            updatedAt: new Date()
        });

        // Also mark class students as inactive
        await classStudentCollection.updateMany(
            { classId: classId },
            { isActive: false }
        );

        console.log(`🗄️ Class archived: ${existingClass.name}`);

        res.json({
            success: true,
            message: 'Class archived successfully!'
        });

    } catch (error) {
        console.error('❌ Error archiving class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to archive class: ' + error.message
        });
    }
});

// ==================== STUDENT MANAGEMENT ROUTES ====================

// ➕ Add student to class (ENHANCED DEBUG VERSION)
app.post('/api/classes/:classId/students', isAuthenticated, async (req, res) => {
    try {
        console.log('🔍 Add student request:', {
            userType: req.session.userType,
            userId: req.session.userId,
            userName: req.session.userName,
            classId: req.params.classId,
            body: req.body,
            ip: req.ip,
            userAgent: req.get('User-Agent')?.substring(0, 100)
        });

        if (req.session.userType !== 'teacher') {
            console.log('❌ Access denied - not a teacher:', req.session.userType);
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Teachers only.',
                debug: {
                    userType: req.session.userType,
                    expectedType: 'teacher',
                    sessionId: req.sessionID
                }
            });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { enrollmentNumber } = req.body;

        console.log('📝 Adding student to class:', {
            classId,
            teacherId,
            enrollmentNumber,
            userName: req.session.userName
        });

        if (!enrollmentNumber) {
            return res.status(400).json({
                success: false,
                message: 'Student enrollment number is required.'
            });
        }

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            console.log('❌ Class not found or access denied:', {
                classId,
                teacherId
            });
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        console.log('✅ Class verified:', classDoc.name);

        // Find student by enrollment number
        const student = await studentCollection.findOne({
            enrollment: enrollmentNumber.trim()
        });

        if (!student) {
            console.log('❌ Student not found:', enrollmentNumber);
            return res.status(404).json({
                success: false,
                message: 'Student not found with this enrollment number.'
            });
        }

        console.log('✅ Student found:', student.name);

        // Check if student is already enrolled in this class
        const existingEnrollment = await classStudentCollection.findOne({
            classId: classId,
            studentId: student._id
        });

        if (existingEnrollment) {
            console.log('⚠️ Existing enrollment found:', {
                isActive: existingEnrollment.isActive,
                enrollmentId: existingEnrollment._id
            });
            
            if (existingEnrollment.isActive) {
                return res.status(400).json({
                    success: false,
                    message: 'Student is already enrolled in this class.'
                });
            } else {
                // Reactivate enrollment
                await classStudentCollection.findByIdAndUpdate(existingEnrollment._id, {
                    isActive: true,
                    enrolledAt: new Date()
                });
                console.log('✅ Student enrollment reactivated');
            }
        } else {
            // Create new enrollment
            const newEnrollment = await classStudentCollection.create({
                classId: classId,
                studentId: student._id,
                studentName: student.name,
                studentEnrollment: student.enrollment
            });
            console.log('✅ New student enrollment created:', newEnrollment._id);
        }

        // Update class student count
        const totalActiveStudents = await classStudentCollection.countDocuments({
            classId: classId,
            isActive: true
        });
        
        await classCollection.findByIdAndUpdate(classId, {
            studentCount: totalActiveStudents,
            updatedAt: new Date()
        });

        console.log(`✅ Student ${student.name} (${student.enrollment}) added to class ${classDoc.name}`);

        res.json({
            success: true,
            message: `Student ${student.name} added to class successfully!`,
            student: {
                studentId: student._id,
                studentName: student.name,
                studentEnrollment: student.enrollment,
                enrolledAt: new Date(),
                totalQuizzes: 0,
                averageScore: 0,
                lastActivity: new Date(),
                participationRate: 0
            }
        });

    } catch (error) {
        console.error('❌ Error adding student to class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add student: ' + error.message,
            debug: {
                error: error.message,
                stack: error.stack
            }
        });
    }
});

// 👥 Get students in a class (MISSING ROUTE - ADD THIS)
app.get('/api/classes/:classId/students', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('👥 Loading students for class:', {
            classId: classId,
            teacherId: teacherId,
            requestedBy: req.session.userName
        });

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            console.log('❌ Class not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        console.log('✅ Class verified:', classDoc.name);

        // Get students enrolled in this class
        const enrollments = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        console.log(`📋 Found ${enrollments.length} active enrollments`);

        // Get quiz results for performance stats
        const studentsWithStats = await Promise.all(
            enrollments.map(async (enrollment) => {
                // Get student's quiz results for this class
                const studentResults = await quizResultCollection.find({
                    studentId: enrollment.studentId,
                    classId: classId
                }).lean();

                const totalQuizzes = studentResults.length;
                const averageScore = totalQuizzes > 0 
                    ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
                    : 0;

                const lastActivity = totalQuizzes > 0 
                    ? studentResults[studentResults.length - 1].submissionDate 
                    : enrollment.enrolledAt;

                return {
                    studentId: enrollment.studentId,
                    studentName: enrollment.studentName,
                    studentEnrollment: enrollment.studentEnrollment,
                    enrolledAt: enrollment.enrolledAt,
                    totalQuizzes: totalQuizzes,
                    averageScore: parseFloat(averageScore),
                    lastActivity: lastActivity,
                    participationRate: totalQuizzes > 0 ? 100 : 0 // Simple calculation
                };
            })
        );

        console.log(`✅ Students loaded with stats: ${studentsWithStats.length}`);

        res.json({
            success: true,
            students: studentsWithStats,
            totalStudents: studentsWithStats.length,
            className: classDoc.name
        });

    } catch (error) {
        console.error('❌ Error fetching students:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch students: ' + error.message
        });
    }
});

// 🔍 DEBUG ROUTE - Add this temporarily to check sessions
app.get('/api/debug/session-check', (req, res) => {
    res.json({
        sessionExists: !!req.session,
        sessionData: {
            userId: req.session?.userId,
            userName: req.session?.userName,
            userType: req.session?.userType,
            sessionID: req.sessionID
        },
        headers: {
            cookie: req.headers.cookie,
            userAgent: req.headers['user-agent']
        },
        timestamp: new Date().toISOString()
    });
});

// 🗑️ Remove student from class
app.delete('/api/classes/:classId/students/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const { classId, studentId } = req.params;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Find and remove enrollment
        const enrollment = await classStudentCollection.findOneAndUpdate(
            {
                classId: classId,
                studentId: studentId,
                isActive: true
            },
            {
                isActive: false
            },
            { new: true }
        );

        if (!enrollment) {
            return res.status(404).json({
                success: false,
                message: 'Student not found in this class.'
            });
        }

        console.log(`🗑️ Student ${enrollment.studentName} removed from class ${classDoc.name}`);

        res.json({
            success: true,
            message: 'Student removed from class successfully!'
        });

    } catch (error) {
        console.error('❌ Error removing student from class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove student: ' + error.message
        });
    }
});

// ==================== CLASS STATISTICS & ANALYTICS ROUTES ====================

// 📊 Get class overview for management page (FIXED VERSION)
app.get('/api/classes/:classId/overview', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Get class basic info
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get recent quiz results for performance trends
        const recentResults = await quizResultCollection.find({
            classId: classId
        })
        .sort({ submissionDate: -1 })
        .limit(10)
        .lean();

        // Get top performers (last 30 days)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const recentStudentResults = await quizResultCollection.find({
            classId: classId,
            submissionDate: { $gte: thirtyDaysAgo }
        }).lean();

        // Calculate top performers
        const studentPerformance = {};
        recentStudentResults.forEach(result => {
            if (!studentPerformance[result.studentId]) {
                studentPerformance[result.studentId] = {
                    studentName: result.studentName,
                    scores: [],
                    totalQuizzes: 0
                };
            }
            studentPerformance[result.studentId].scores.push(result.percentage);
            studentPerformance[result.studentId].totalQuizzes++;
        });

        const topPerformers = Object.values(studentPerformance)
            .map(student => ({
                studentName: student.studentName,
                averageScore: (student.scores.reduce((a, b) => a + b, 0) / student.scores.length).toFixed(1),
                totalQuizzes: student.totalQuizzes
            }))
            .sort((a, b) => parseFloat(b.averageScore) - parseFloat(a.averageScore))
            .slice(0, 5);

        console.log(`📊 Overview generated for class ${classDoc.name}`);

        res.json({
            success: true,
            classData: {
                id: classDoc._id,
                name: classDoc.name,
                subject: classDoc.subject,
                description: classDoc.description,
                studentCount: classDoc.studentCount || 0,
                lectureCount: classDoc.lectureCount || 0,
                quizCount: classDoc.quizCount || 0,
                averageScore: classDoc.averageScore || 0,
                createdAt: classDoc.createdAt,
                updatedAt: classDoc.updatedAt
            },
            recentActivity: recentResults.map(result => ({
                studentName: result.studentName,
                score: result.percentage,
                submissionDate: result.submissionDate.toLocaleDateString(),
                timeTaken: Math.floor(result.timeTakenSeconds / 60) + 'm'
            })),
            topPerformers: topPerformers,
            performanceTrend: recentResults.slice(0, 7).reverse().map(result => ({
                date: result.submissionDate.toLocaleDateString(),
                score: result.percentage
            }))
        });

    } catch (error) {
        console.error('❌ Error generating class overview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate overview: ' + error.message
        });
    }
});

// 📈 Get detailed class analytics
app.get('/api/classes/:classId/analytics', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get all quiz results for this class
        const allResults = await quizResultCollection.find({
            classId: classId
        }).lean();

        // Get all quizzes for this class
        const classQuizzes = await quizCollection.find({
            classId: classId
        }).lean();

        // Calculate detailed analytics
        const analytics = {
            totalParticipants: new Set(allResults.map(r => r.studentId.toString())).size,
            totalQuizAttempts: allResults.length,
            classAverage: allResults.length > 0 
                ? (allResults.reduce((sum, r) => sum + r.percentage, 0) / allResults.length).toFixed(1)
                : 0,
            highestScore: allResults.length > 0 
                ? Math.max(...allResults.map(r => r.percentage)).toFixed(1)
                : 0,
            lowestScore: allResults.length > 0 
                ? Math.min(...allResults.map(r => r.percentage)).toFixed(1)
                : 0,
            
            // Performance distribution
            performanceDistribution: {
                excellent: allResults.filter(r => r.percentage >= 90).length,
                good: allResults.filter(r => r.percentage >= 70 && r.percentage < 90).length,
                average: allResults.filter(r => r.percentage >= 50 && r.percentage < 70).length,
                needsImprovement: allResults.filter(r => r.percentage < 50).length
            },

            // Quiz performance breakdown
            quizPerformance: classQuizzes.map(quiz => {
                const quizResults = allResults.filter(r => r.quizId.toString() === quiz._id.toString());
                return {
                    quizId: quiz._id,
                    quizTitle: quiz.lectureTitle,
                    totalAttempts: quizResults.length,
                    averageScore: quizResults.length > 0 
                        ? (quizResults.reduce((sum, r) => sum + r.percentage, 0) / quizResults.length).toFixed(1)
                        : 0,
                    highestScore: quizResults.length > 0 
                        ? Math.max(...quizResults.map(r => r.percentage)).toFixed(1)
                        : 0,
                    lowestScore: quizResults.length > 0 
                        ? Math.min(...quizResults.map(r => r.percentage)).toFixed(1)
                        : 0
                };
            })
        };

        console.log(`📈 Analytics generated for class ${classDoc.name}`);

        res.json({
            success: true,
            analytics: analytics,
            className: classDoc.name
        });

    } catch (error) {
        console.error('❌ Error generating class analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate analytics: ' + error.message
        });
    }
});

// ==================== PAGE ROUTES ====================

// 🏫 Render class management page
app.get('/class/manage/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Get class info
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(404).send('Class not found or access denied.');
        }

        console.log(`🏫 Rendering class management page for: ${classDoc.name}`);

        res.render('classManagement', {
            classId: classId,
            className: classDoc.name,
            classSubject: classDoc.subject,
            userName: req.session.userName,
            userType: req.session.userType
        });

    } catch (error) {
        console.error('❌ Error rendering class management page:', error);
        res.status(500).send('Failed to load class management page.');
    }
});

// ==================== LECTURE MANAGEMENT ROUTES ====================

app.post("/upload_lecture", isAuthenticated, upload.single('lectureFile'), async (req, res) => {
    let tempFilePath = null;

    try {
        if (req.fileError) {
            return res.status(400).json({
                success: false,
                message: req.fileError.message
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const { title, classId } = req.body; // 🆕 NEW: classId parameter
        const file = req.file;
        tempFilePath = file.path;

        console.log('📁 Processing file for class:', {
            originalName: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
            tempPath: file.path,
            classId: classId
        });

        const professorId = req.session.userId;
        const professorName = req.session.userName;

        if (!professorId || !professorName || req.session.userType !== 'teacher') {
            console.warn('⚠️ User not identified as a teacher in session for lecture upload.');
            return req.session.destroy(err => {
                res.status(401).json({
                    success: false,
                    message: 'Authentication required. Please log in as a teacher.'
                });
            });
        }

        // 🆕 NEW: Verify class ownership if classId provided
        let className = null;
        if (classId) {
            const classDoc = await classCollection.findOne({
                _id: classId,
                teacherId: professorId,
                isActive: true
            });

            if (!classDoc) {
                return res.status(403).json({
                    success: false,
                    message: 'Class not found or access denied.'
                });
            }
            className = classDoc.name;
        }

        const extractedText = await extractTextFromFile(file.path, file.mimetype);

        console.log('📝 Text extraction completed:', {
            totalLength: extractedText.length,
            preview: extractedText.substring(0, 200) + '...'
        });

        cleanupTempFile(tempFilePath);
        console.log(`🗑️ Temporary file cleaned up after extraction.`);

        // 🔄 UPDATED: Include class information in lecture data
        const lectureData = {
            title: title,
            filePath: '',
            originalFileName: file.originalname,
            mimeType: file.mimetype,
            fileSize: file.size,
            extractedText: extractedText,
            textLength: extractedText.length,
            uploadDate: new Date(),
            fileType: getFileType(file.mimetype),
            quizGenerated: false,
            processingStatus: 'completed',
            professorName: professorName,
            professorId: professorId,
            // 🆕 NEW: Class association
            classId: classId || null,
            className: className || null
        };

        const savedLecture = await lectureCollection.create(lectureData);
        console.log('✅ Lecture saved to database:', savedLecture._id);

        // 🆕 NEW: Return structured response for API usage
        res.json({
            success: true,
            message: `Lecture uploaded successfully${className ? ` to class ${className}` : ''}!`,
            lectureId: savedLecture._id,
            title: savedLecture.title,
            className: className
        });

    } catch (error) {
        console.error('❌ Upload processing error:', error);

        if (tempFilePath && fs.existsSync(tempFilePath)) {
            cleanupTempFile(tempFilePath);
        }

        res.status(500).json({
            success: false,
            message: 'Failed to process uploaded file: ' + error.message
        });
    }
});

app.get('/lectures/:id/text', isAuthenticated, async (req, res) => {
    try {
        const lecture = await lectureCollection.findById(req.params.id)
            .select('extractedText title textLength professorId')

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
             return res.status(403).json({ success: false, message: 'Access denied. You do not own this lecture.' });
        }

        res.json({
            success: true,
            data: {
                id: lecture._id,
                title: lecture.title,
                textLength: lecture.textLength,
                extractedText: lecture.extractedText
            }
        })
    } catch (error) {
        console.error('❌ Error fetching lecture text:', error)
        res.status(500).json({
            success: false,
            message: 'Error loading lecture text'
        })
    }
})

// ==================== ENHANCED QUIZ GENERATION ROUTE ====================

// 🔄 UPDATED: Enhanced quiz generation with class association
app.post('/generate_quiz/:id', isAuthenticated, async (req, res) => {
    try {
        const lectureId = req.params.id
        console.log(`🔄 Starting ENHANCED quiz generation for lecture ID: ${lectureId}`)
        
        const lecture = await lectureCollection.findById(lectureId)

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        // Check ownership
        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
             return res.status(403).json({ success: false, message: 'Access denied. You can only generate quizzes for your own lectures.' });
        }

        // Check if quiz already exists
        const existingQuiz = await quizCollection.findOne({ lectureId: lectureId })
        if (existingQuiz) {
            return res.status(400).json({
                success: false,
                message: 'Quiz already generated for this lecture'
            })
        }

        // Update lecture status to processing
        await lectureCollection.findByIdAndUpdate(lectureId, {
            processingStatus: 'processing',
            lastProcessed: new Date()
        })

        console.log('🤖 ENHANCED AI Quiz Generation Started for:', lecture.title)

        const extractedText = lecture.extractedText

        if (!extractedText || extractedText.length < 50) {
            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'Text too short for quiz generation'
            })
            return res.status(400).json({ 
                success: false, 
                message: 'Extracted text is too short or missing for quiz generation.' 
            })
        }

        // [SAME ENHANCED PROMPT AS BEFORE - keeping it for consistency]
        const prompt = `
        You are an expert quiz generator and educational content creator. Create a comprehensive multiple-choice quiz with detailed explanations based on the following lecture content.

        **STRICT REQUIREMENTS:**
        1. Generate exactly 10 multiple-choice questions
        2. Each question must have exactly 4 options (A, B, C, D)
        3. Questions should test understanding, not just memorization
        4. Mix difficulty levels: 3 easy, 4 medium, 3 hard questions
        5. Ensure all questions are directly based on the lecture content
        6. Make wrong options plausible but clearly incorrect
        7. Provide detailed explanations for EACH wrong answer option
        8. Provide a comprehensive explanation for the correct answer
        9. Output must be valid JSON only, no extra text

        **LECTURE CONTENT:**
        ${extractedText.substring(0, 4000)}

        **REQUIRED JSON FORMAT - MUST INCLUDE EXPLANATIONS:**
        [
          {
            "question": "Clear, complete question text here?",
            "options": {
              "A": "First option",
              "B": "Second option", 
              "C": "Third option",
              "D": "Fourth option"
            },
            "correct_answer": "B",
            "correctAnswerExplanation": "Detailed explanation of why B is correct, referencing specific content from the lecture.",
            "explanations": {
              "A": "Explanation of why A is incorrect and what concept it might confuse with specific reference to lecture content",
              "B": "",
              "C": "Explanation of why C is incorrect and what the student might have misunderstood, with reference to lecture material",
              "D": "Explanation of why D is incorrect and how to avoid this mistake, connecting to lecture concepts"
            }
          }
        ]

        **EXPLANATION GUIDELINES:**
        - Each wrong answer explanation should be 2-3 sentences
        - Reference specific concepts from the lecture material provided
        - Explain the common misconception or mistake
        - Provide educational guidance on the correct concept
        - Use encouraging and educational tone
        - The correct answer should have empty string in explanations object
        - Use correctAnswerExplanation field for detailed explanation of correct answer
        - All explanations must be educational and helpful for learning

        Generate exactly 10 questions following this format with comprehensive explanations for each wrong answer.`

        try {
            const generationConfig = {
                temperature: 0.3,
                topP: 0.8,
                topK: 40,
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
            }

            const safetySettings = [
                {
                    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
            ]

            console.log('📤 Sending ENHANCED request to Gemini API...')
            
            const result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig,
                safetySettings,
            })

            const response = result.response
            let quizContent = response.text()

            console.log('✅ Received ENHANCED response from Gemini API')

            // Parse and validate the AI response
            let generatedQuiz = null
            try {
                quizContent = quizContent.trim()
                if (quizContent.startsWith('```json')) {
                    quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim()
                }
                
                generatedQuiz = JSON.parse(quizContent)
                
                // Enhanced validation
                if (!Array.isArray(generatedQuiz)) {
                    throw new Error('Response is not an array')
                }
                
                if (generatedQuiz.length === 0) {
                    throw new Error('No questions generated')
                }
                
                // Validate each question WITH explanations
                generatedQuiz.forEach((q, index) => {
                    if (!q.question || !q.options || !q.correct_answer || !q.explanations || !q.correctAnswerExplanation) {
                        throw new Error(`Question ${index + 1} is missing required fields (including explanations)`)
                    }
                    if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) {
                        throw new Error(`Question ${index + 1} has invalid correct_answer`)
                    }
                    
                    // Validate explanations exist for wrong answers
                    ['A', 'B', 'C', 'D'].forEach(option => {
                        if (option !== q.correct_answer && (!q.explanations[option] || q.explanations[option].trim() === '')) {
                            console.warn(`⚠️ Question ${index + 1}: Missing explanation for wrong answer ${option}`);
                            // Set fallback explanation
                            q.explanations[option] = `This option is incorrect. The correct answer is ${q.correct_answer}. Please review the lecture material for more details.`;
                        }
                    });
                    
                    // Ensure correct answer has empty explanation in explanations object
                    q.explanations[q.correct_answer] = "";
                })
                
                console.log('🎯 ENHANCED quiz validated:', {
                    totalQuestions: generatedQuiz.length,
                    hasExplanations: !!generatedQuiz[0].explanations,
                    hasCorrectExplanation: !!generatedQuiz[0].correctAnswerExplanation
                });
                
            } catch (parseError) {
                console.error('❌ Failed to parse ENHANCED quiz JSON:', parseError)
                
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Enhanced AI response parsing failed: ' + parseError.message
                })
                
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to parse enhanced AI response. Please try again.' 
                })
            }

            // 🔄 UPDATED: Save the ENHANCED quiz with class association
            const newQuiz = {
                lectureId: lectureId,
                lectureTitle: lecture.title,
                questions: generatedQuiz,
                totalQuestions: generatedQuiz.length,
                generatedDate: new Date(),
                createdBy: req.session.userId,
                // 🆕 NEW: Include class information
                classId: lecture.classId || null,
                className: lecture.className || null
            }

            try {
                const savedQuiz = await quizCollection.create(newQuiz)
                console.log('✅ ENHANCED quiz saved to database:', savedQuiz._id)
                
                // Update lecture status
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    quizGenerated: true,
                    processingStatus: 'completed',
                    quizzesCount: 1,
                    lastProcessed: new Date()
                })

                console.log('✅ ENHANCED quiz generation completed successfully for:', lecture.title)

                // 🆕 NEW: Return enhanced response with class info
                res.json({
                    success: true,
                    message: `Enhanced quiz generated successfully with ${generatedQuiz.length} questions and detailed explanations!`,
                    quizId: savedQuiz._id,
                    totalQuestions: generatedQuiz.length,
                    title: lecture.title,
                    className: lecture.className,
                    explanationsGenerated: true
                })
                
            } catch (saveError) {
                console.error('❌ Error saving ENHANCED quiz to MongoDB:', saveError)
                
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Enhanced database save error: ' + saveError.message
                })
                
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to save enhanced quiz to database: ' + saveError.message 
                })
            }

        } catch (apiError) {
            console.error('❌ ENHANCED Gemini API Error:', apiError)

            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'Enhanced AI API Error: ' + apiError.message
            })

            if (apiError.message.includes('quota') || apiError.message.includes('limit')) {
                return res.status(429).json({ 
                    success: false, 
                    message: 'API quota exceeded. Please try again later.' 
                })
            }

            res.status(500).json({ 
                success: false, 
                message: 'Failed to generate enhanced quiz. Please check your API key and try again.' 
            })
        }
    
    } catch (error) {
        console.error('❌ ENHANCED quiz generation error:', error)
        
        if (req.params.id) {
            await lectureCollection.findByIdAndUpdate(req.params.id, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: error.message
            })
        }

        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate enhanced quiz: ' + error.message 
        })
    }
});

// ==================== DELETE LECTURE ROUTE ====================

app.post('/delete_lecture/:id', isAuthenticated, async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
             return res.status(403).json({ success: false, message: 'Access denied. You can only delete your own lectures.' });
        }

        // Delete associated quizzes first
        await quizCollection.deleteMany({ lectureId: lectureId })
        // Delete associated quiz results
        await quizResultCollection.deleteMany({ lectureId: lectureId })

        // Delete lecture record
        await lectureCollection.findByIdAndDelete(lectureId)

        console.log('🗑️ Lecture, quizzes, and results deleted:', lecture.title)

        res.json({
            success: true,
            message: 'Lecture deleted successfully'
        })
    } catch (error) {
        console.error('❌ Error deleting lecture:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to delete lecture'
        })
    }
})

// ==================== STUDENT QUIZ ROUTES ====================

app.get('/api/student/available-quizzes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;

        // Get all classes the student is enrolled in
        const enrollments = await classStudentCollection.find({
            studentId: studentId,
            isActive: true
        }).lean();

        if (enrollments.length === 0) {
            return res.json({
                success: true,
                quizzes: [],
                message: 'Not enrolled in any classes.'
            });
        }

        const enrolledClassIds = enrollments.map(e => e.classId);

        // Get all available quizzes from enrolled classes
        const availableQuizzes = await quizCollection.find({
            classId: { $in: enrolledClassIds },
            isActive: true
        })
        .select('lectureTitle totalQuestions classId generatedDate')
        .sort({ generatedDate: -1 })
        .lean();

        // Get quizzes already taken by student
        const takenQuizIds = await quizResultCollection.find({
            studentId: studentId
        }).distinct('quizId');

        // Filter out taken quizzes and add class information
        const quizzesWithClassInfo = await Promise.all(
            availableQuizzes
                .filter(quiz => !takenQuizIds.includes(quiz._id.toString()))
                .map(async (quiz) => {
                    const classInfo = await classCollection.findById(quiz.classId).select('name subject').lean();
                    return {
                        _id: quiz._id,
                        lectureTitle: quiz.lectureTitle,
                        totalQuestions: quiz.totalQuestions,
                        generatedDate: quiz.generatedDate,
                        classId: quiz.classId,
                        className: classInfo ? classInfo.name : 'Unknown Class',
                        classSubject: classInfo ? classInfo.subject : 'Unknown Subject'
                    };
                })
        );

        console.log(`🎯 Found ${quizzesWithClassInfo.length} available quizzes across all enrolled classes`);

        res.json({
            success: true,
            quizzes: quizzesWithClassInfo,
            totalQuizzes: quizzesWithClassInfo.length
        });

    } catch (error) {
        console.error('❌ Error fetching available quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load available quizzes: ' + error.message
        });
    }
});


// 🔄 REPLACE your existing /take_quiz/:quizId route with this enhanced version:

app.get('/take_quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Only students can take quizzes.');
        }

        const quizId = req.params.quizId;
        const classId = req.query.classId; // Optional class context

        // Get quiz details
        const quiz = await quizCollection.findById(quizId).select('lectureTitle totalQuestions classId').lean();

        if (!quiz) {
            return res.status(404).send('Quiz not found.');
        }

        // If student is coming from a class context, verify enrollment
        if (classId || quiz.classId) {
            const targetClassId = classId || quiz.classId;
            const enrollment = await classStudentCollection.findOne({
                studentId: req.session.userId,
                classId: targetClassId,
                isActive: true
            });

            if (!enrollment) {
                return res.status(403).send('You are not enrolled in this class.');
            }
        }

        // Check if student has already taken this quiz
        const existingResult = await quizResultCollection.findOne({
            quizId: quizId,
            studentId: req.session.userId
        });

        if (existingResult) {
            return res.redirect(`/quiz-results?alreadyTaken=true&quizTitle=${encodeURIComponent(quiz.lectureTitle)}`);
        }

        // Get class information for context
        let classInfo = null;
        if (quiz.classId) {
            classInfo = await classCollection.findById(quiz.classId).select('name subject').lean();
        }

        console.log(`🎯 Rendering take quiz page for: ${quiz.lectureTitle} (Class: ${classInfo?.name || 'N/A'})`);

        // 🆕 ENHANCED: Pass complete class context to template
        res.render('takeQuiz', {
            quiz: {
                ...quiz,
                classId: quiz.classId, // 🔥 IMPORTANT: Pass classId to template
                className: classInfo?.name,
                classSubject: classInfo?.subject
            },
            userName: req.session.userName,
            classContext: !!classId
        });

    } catch (error) {
        console.error('❌ Error rendering take quiz page:', error);
        res.status(500).send('Failed to load quiz page.');
    }
});

app.get('/api/quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can access quiz questions.' });
        }

        const quizId = req.params.quizId;
        const quiz = await quizCollection.findById(quizId).select('questions totalQuestions lectureTitle').lean();

        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        // Only send question text and options to students (not correct answers or explanations)
        const questionsForClient = quiz.questions.map(q => ({
            question: q.question,
            options: q.options,
        }));

        res.json({
            success: true,
            quiz: {
                _id: quiz._id,
                lectureTitle: quiz.lectureTitle,
                totalQuestions: quiz.totalQuestions,
                questions: questionsForClient
            }
        });

    } catch (error) {
        console.error('❌ Error fetching quiz for student:', error);
        res.status(500).json({ success: false, message: 'Failed to load quiz questions.' });
    }
});

// 🔄 UPDATED: Enhanced quiz submission (class-aware)
app.post('/api/quiz/submit/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can submit quizzes.' });
        }

        const quizId = req.params.quizId;
        const { studentAnswers, timeTakenSeconds } = req.body;

        const studentId = req.session.userId;
        const studentName = req.session.userName;

        // Get complete quiz data including class information
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found for scoring.' });
        }

        // Verify class enrollment if quiz belongs to a class
        if (quiz.classId) {
            const enrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: quiz.classId,
                isActive: true
            });

            if (!enrollment) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'You are not enrolled in the class for this quiz.' 
                });
            }
        }

        // Check for duplicate submission
        const existingResult = await quizResultCollection.findOne({
            quizId: quizId,
            studentId: studentId
        });

        if (existingResult) {
            return res.status(400).json({ 
                success: false, 
                message: 'You have already submitted this quiz.' 
            });
        }

        let score = 0;
        const totalQuestions = quiz.totalQuestions;
        const detailedAnswers = [];
        const enhancedQuestionDetails = [];

        // Score the quiz and prepare detailed results
        studentAnswers.forEach(sAnswer => {
            const correspondingQuestion = quiz.questions[sAnswer.questionIndex];
            if (correspondingQuestion) {
                const isCorrect = sAnswer.selectedOption === correspondingQuestion.correct_answer;
                if (isCorrect) {
                    score++;
                }
                
                detailedAnswers.push({
                    questionIndex: sAnswer.questionIndex,
                    question: sAnswer.question,
                    selectedOption: sAnswer.selectedOption,
                    correctOption: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });

                enhancedQuestionDetails.push({
                    questionIndex: sAnswer.questionIndex,
                    questionText: correspondingQuestion.question,
                    options: correspondingQuestion.options,
                    studentAnswer: sAnswer.selectedOption,
                    correctAnswer: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });
            }
        });

        const percentage = (totalQuestions > 0) ? (score / totalQuestions) * 100 : 0;

        // Save quiz result to database (with class information)
        const newQuizResult = {
            quizId: quizId,
            lectureId: quiz.lectureId,
            classId: quiz.classId || null, // Include class ID
            studentId: studentId,
            studentName: studentName,
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            submissionDate: new Date(),
            answers: detailedAnswers
        };

        const savedResult = await quizResultCollection.create(newQuizResult);
        console.log(`✅ Quiz result saved for student ${studentName} on quiz ${quiz.lectureTitle}: Score ${score}/${totalQuestions}`);

        // Get class information for response
        let classInfo = null;
        if (quiz.classId) {
            classInfo = await classCollection.findById(quiz.classId).select('name subject').lean();
        }

        res.json({
            success: true,
            message: 'Quiz submitted and scored successfully!',
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            quizResultId: savedResult._id,
            // Enhanced response with class context
            lectureId: quiz.lectureId,
            classId: quiz.classId,
            className: classInfo?.name,
            quizTitle: quiz.lectureTitle,
            questionDetails: enhancedQuestionDetails,
            quizId: quizId
        });

    } catch (error) {
        console.error('❌ Error submitting or scoring quiz:', error);
        res.status(500).json({ success: false, message: 'Failed to submit quiz: ' + error.message });
    }
});

app.get('/api/teacher/class/:classId/quizzes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get all quizzes for this class
        const quizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        })
        .sort({ generatedDate: -1 })
        .lean();

        // Enhance quiz data with performance stats
        const enhancedQuizzes = await Promise.all(
            quizzes.map(async (quiz) => {
                const quizResults = await quizResultCollection.find({
                    quizId: quiz._id
                }).lean();

                return {
                    _id: quiz._id,
                    lectureId: quiz.lectureId,
                    lectureTitle: quiz.lectureTitle,
                    totalQuestions: quiz.totalQuestions,
                    generatedDate: quiz.generatedDate,
                    isActive: quiz.isActive,
                    totalAttempts: quizResults.length,
                    averageScore: quizResults.length > 0 
                        ? (quizResults.reduce((sum, r) => sum + r.percentage, 0) / quizResults.length).toFixed(1)
                        : 0,
                    highestScore: quizResults.length > 0 
                        ? Math.max(...quizResults.map(r => r.percentage)).toFixed(1)
                        : 0
                };
            })
        );

        console.log(`📝 Found ${enhancedQuizzes.length} quizzes for class ${classDoc.name}`);

        res.json({
            success: true,
            quizzes: enhancedQuizzes,
            totalQuizzes: enhancedQuizzes.length,
            className: classDoc.name
        });

    } catch (error) {
        console.error('❌ Error fetching class quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch quizzes: ' + error.message
        });
    }
});

// 🏫 Get student's enrolled classes
app.get('/api/student/enrolled-classes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        
        // Get classes the student is enrolled in
        const enrollments = await classStudentCollection.find({
            studentId: studentId,
            isActive: true
        }).lean();

        if (enrollments.length === 0) {
            return res.json({
                success: true,
                classes: [],
                message: 'No enrolled classes found.'
            });
        }

        // Get class details and student's performance in each class
        const enrolledClasses = await Promise.all(
            enrollments.map(async (enrollment) => {
                // Get class details
                const classDetails = await classCollection.findById(enrollment.classId).lean();
                
                if (!classDetails) {
                    return null; // Skip if class doesn't exist
                }

                // Get teacher name
                const teacher = await teacherCollection.findById(classDetails.teacherId).select('name').lean();

                // Get available quizzes for this class
                const availableQuizzes = await quizCollection.countDocuments({
                    classId: enrollment.classId,
                    isActive: true
                });

                // Get student's quiz results for this class
                const studentResults = await quizResultCollection.find({
                    studentId: studentId,
                    classId: enrollment.classId
                }).lean();

                // Calculate student's stats for this class
                const quizzesTaken = studentResults.length;
                const averageScore = quizzesTaken > 0 
                    ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / quizzesTaken).toFixed(1)
                    : 0;

                return {
                    classId: classDetails._id,
                    className: classDetails.name,
                    classSubject: classDetails.subject,
                    classDescription: classDetails.description,
                    teacherName: teacher ? teacher.name : 'Unknown Teacher',
                    enrolledAt: enrollment.enrolledAt,
                    // Student's performance in this class
                    quizzesTaken: quizzesTaken,
                    averageScore: parseFloat(averageScore),
                    availableQuizzes: availableQuizzes
                };
            })
        );

        // Filter out null values (deleted classes)
        const validClasses = enrolledClasses.filter(cls => cls !== null);

        console.log(`🏫 Found ${validClasses.length} enrolled classes for student ${req.session.userName}`);

        res.json({
            success: true,
            classes: validClasses,
            totalClasses: validClasses.length
        });

    } catch (error) {
        console.error('❌ Error fetching enrolled classes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrolled classes: ' + error.message
        });
    }
});


// ==================== SIMPLE STUDENT CLASS REDIRECT (ADD THIS TO INDEX.JS) ====================

// 🎓 Simple redirect for student class view (breadcrumb navigation)
app.get('/student/class/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Students only.');
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).redirect('/homeStudent?message=You are not enrolled in this class.');
        }

        // Get class name for context
        const classInfo = await classCollection.findById(classId).select('name').lean();
        const className = classInfo ? classInfo.name : 'Unknown Class';

        console.log(`🎓 Student ${req.session.userName} accessing class: ${className}`);

        // For now, redirect to student dashboard with class context
        // Later you can create a dedicated student class view page
        res.redirect(`/homeStudent?class=${classId}&className=${encodeURIComponent(className)}`);

    } catch (error) {
        console.error('❌ Error accessing student class:', error);
        res.status(500).redirect('/homeStudent?message=Failed to access class information.');
    }
});

// 🎯 Get available quizzes for a specific class (student enrolled)
app.get('/api/student/class/:classId/quizzes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student is enrolled in this class
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get available quizzes for this class
        const quizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        })
        .select('lectureTitle totalQuestions generatedDate')
        .sort({ generatedDate: -1 })
        .lean();

        // Check which quizzes the student has already taken
        const takenQuizIds = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        }).distinct('quizId');

        // Mark quizzes as taken or available
        const quizzesWithStatus = quizzes.map(quiz => ({
            _id: quiz._id,
            lectureTitle: quiz.lectureTitle,
            totalQuestions: quiz.totalQuestions,
            generatedDate: quiz.generatedDate,
            status: takenQuizIds.includes(quiz._id.toString()) ? 'taken' : 'available'
        }));

        // Separate available and taken quizzes
        const availableQuizzes = quizzesWithStatus.filter(q => q.status === 'available');
        const takenQuizzes = quizzesWithStatus.filter(q => q.status === 'taken');

        console.log(`🎯 Found ${availableQuizzes.length} available quizzes for student in class ${classId}`);

        res.json({
            success: true,
            quizzes: availableQuizzes, // Only return available quizzes
            takenQuizzes: takenQuizzes, // Also return taken quizzes for reference
            totalAvailable: availableQuizzes.length,
            totalTaken: takenQuizzes.length
        });

    } catch (error) {
        console.error('❌ Error fetching class quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class quizzes: ' + error.message
        });
    }
});

// ==================== TEACHER RESULTS ROUTES ====================

// ==================== UPDATED LECTURE RESULTS ROUTE ====================
app.get('/lecture_results/:lectureId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Only teachers can view lecture results.');
        }

        const lectureId = req.params.lectureId;
        
        // Get lecture details
        const lecture = await lectureCollection.findById(lectureId).lean();
        if (!lecture) {
            return res.status(404).send('Lecture not found.');
        }

        // Verify ownership
        if (!lecture.professorId.equals(req.session.userId)) {
            return res.status(403).send('Access denied. You can only view results for your own lectures.');
        }

        // Get quiz for this lecture
        const quiz = await quizCollection.findOne({ lectureId: lectureId }).lean();
        if (!quiz) {
            return res.render('lectureResults', {
                lectureTitle: lecture.title,
                className: lecture.className,
                subject: lecture.classSubject || 'Unknown Subject',
                quizResults: [],
                userName: req.session.userName || "Teacher",
                message: 'No quiz found for this lecture.'
            });
        }

        // Get quiz results
        const quizResults = await quizResultCollection.find({ 
            lectureId: lectureId 
        })
        .sort({ percentage: -1, timeTakenSeconds: 1 }) // Sort by score desc, then time asc
        .lean();

        // Format results with rankings
        const formattedResults = quizResults.map((result, index) => ({
            ...result,
            rank: index + 1,
            submissionDate: result.submissionDate.toLocaleString(),
            rankInClass: index + 1 // For class context if needed
        }));

        // Get class information if available
        let classInfo = null;
        if (lecture.classId) {
            classInfo = await classCollection.findById(lecture.classId).select('name subject').lean();
        }

        console.log(`📊 Rendering lecture results for: ${lecture.title} (${formattedResults.length} results)`);

        res.render('lectureResults', {
            lectureTitle: lecture.title,
            className: classInfo ? classInfo.name : lecture.className,
            subject: classInfo ? classInfo.subject : (lecture.classSubject || 'Unknown Subject'),
            quizResults: formattedResults,
            userName: req.session.userName || "Teacher",
            totalStudents: formattedResults.length,
            quizId: quiz._id.toString()
        });

    } catch (error) {
        console.error('❌ Error fetching lecture results:', error);
        res.status(500).send('Failed to load quiz results: ' + error.message);
    }
});

// ==================== ANALYTICS ROUTES ====================

// Student Performance Analytics
// 🔄 FIXED: Student Performance Analytics Route 
app.get('/api/student/performance-data', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

        // Get student's quiz results from last 15 days (class-aware)
        const studentResults = await quizResultCollection
            .find({ 
                studentId: studentId,
                submissionDate: { $gte: fifteenDaysAgo }
            })
            .sort({ submissionDate: -1 })
            .lean();

        // Get all quiz results for comparison (from all classes)
        const allResults = await quizResultCollection
            .find({ submissionDate: { $gte: fifteenDaysAgo } })
            .lean();

        // Get class information for student's results
        const resultsWithClassInfo = await Promise.all(
            studentResults.map(async (result) => {
                const quiz = await quizCollection.findById(result.quizId).select('lectureTitle classId').lean();
                const classInfo = quiz ? await classCollection.findById(quiz.classId).select('name').lean() : null;
                
                return {
                    ...result,
                    quizTitle: quiz ? quiz.lectureTitle : 'Unknown Quiz',
                    className: classInfo ? classInfo.name : 'Unknown Class'
                };
            })
        );

        // Calculate statistics
        const totalQuizzes = studentResults.length;
        const averageScore = totalQuizzes > 0 
            ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
            : 0;

        // Calculate overall class average
        const allScores = allResults.map(r => r.percentage);
        const classAverage = allScores.length > 0 
            ? (allScores.reduce((sum, score) => sum + score, 0) / allScores.length).toFixed(1)
            : 0;

        // Calculate performance trend
        let trendIndicator = '→';
        if (studentResults.length >= 6) {
            const recent3 = studentResults.slice(0, 3).reduce((sum, r) => sum + r.percentage, 0) / 3;
            const previous3 = studentResults.slice(3, 6).reduce((sum, r) => sum + r.percentage, 0) / 3;
            
            if (recent3 > previous3 + 5) trendIndicator = '↗️';
            else if (recent3 < previous3 - 5) trendIndicator = '↘️';
        }

        // Get top 3 performers
        const studentPerformances = {};
        allResults.forEach(result => {
            if (!studentPerformances[result.studentId]) {
                studentPerformances[result.studentId] = {
                    studentName: result.studentName,
                    scores: [],
                    totalQuizzes: 0
                };
            }
            studentPerformances[result.studentId].scores.push(result.percentage);
            studentPerformances[result.studentId].totalQuizzes++;
        });

        const rankedStudents = Object.values(studentPerformances)
            .map(student => ({
                ...student,
                averageScore: student.scores.reduce((sum, score) => sum + score, 0) / student.scores.length
            }))
            .sort((a, b) => b.averageScore - a.averageScore);

        const top3Performers = rankedStudents.slice(0, 3).map((student, index) => ({
            rank: index + 1,
            name: student.studentName,
            averageScore: student.averageScore.toFixed(1),
            totalQuizzes: student.totalQuizzes
        }));

        // Find current student's rank
        const currentStudentRank = rankedStudents.findIndex(s => s.studentName === req.session.userName) + 1;

        // Prepare trend data for charts
        const trendData = resultsWithClassInfo.reverse().map(result => ({
            date: result.submissionDate.toLocaleDateString(),
            score: result.percentage,
            quizTitle: result.quizTitle,
            className: result.className,
            timeTaken: result.timeTakenSeconds
        }));

        // Recent results for table (RENAMED to avoid conflict)
        const displayRecentResults = resultsWithClassInfo.slice(0, 10).map(result => ({
            quizTitle: `${result.className} - ${result.quizTitle}`,
            score: result.percentage,
            submissionDate: result.submissionDate.toLocaleDateString(),
            timeTaken: Math.floor(result.timeTakenSeconds / 60) + 'm ' + (result.timeTakenSeconds % 60) + 's'
        }));

        res.json({
            success: true,
            data: {
                studentStats: {
                    totalQuizzes,
                    averageScore: parseFloat(averageScore),
                    classAverage: parseFloat(classAverage),
                    trendIndicator,
                    currentRank: currentStudentRank || rankedStudents.length + 1,
                    totalStudents: rankedStudents.length
                },
                recentResults: displayRecentResults, // RENAMED variable
                trendData,
                top3Performers,
                performanceBreakdown: {
                    excellent: studentResults.filter(r => r.percentage >= 90).length,
                    good: studentResults.filter(r => r.percentage >= 70 && r.percentage < 90).length,
                    average: studentResults.filter(r => r.percentage >= 50 && r.percentage < 70).length,
                    needsImprovement: studentResults.filter(r => r.percentage < 50).length
                }
            }
        });

    } catch (error) {
        console.error('❌ Error fetching student performance:', error);
        res.status(500).json({ success: false, message: 'Failed to load performance data.' });
    }
});

// Helper functions for safe calculations
function safeNumber(value, defaultValue = 0) {
  const num = Number(value);
  return isNaN(num) || !isFinite(num) ? defaultValue : num;
}

function safeToFixed(value, decimals = 2) {
  const num = safeNumber(value, 0);
  return num.toFixed(decimals);
}

function safePercentage(part, total) {
  const p = safeNumber(part, 0);
  const t = safeNumber(total, 1); // Avoid division by zero
  return t === 0 ? 0 : (p / t) * 100;
}

// 🎯 FIXED ANALYTICS ROUTE - USING YOUR COLLECTION NAMES
app.get('/api/teacher/class-analytics', requireAuth, async (req, res) => {
  try {
    console.log('📊 Starting enhanced analytics calculation...');
    const teacherId = req.session.userId;

    // Get all teacher's lectures (using your collection names)
    const lectures = await lectureCollection.find({ professorId: teacherId }).lean();
    console.log(`Found ${lectures.length} lectures`);

    if (lectures.length === 0) {
      return res.json({
        success: true,
        data: getEmptyAnalyticsData()
      });
    }

    const lectureIds = lectures.map(l => l._id);
    
    // Get all quizzes for these lectures (using your collection names)
    const quizzes = await quizCollection.find({ lectureId: { $in: lectureIds } }).lean();
    console.log(`Found ${quizzes.length} quizzes`);

    // Get all quiz results (using your collection names)
    const results = await quizResultCollection.find({ 
      quizId: { $in: quizzes.map(q => q._id) } 
    }).lean();
    console.log(`Found ${results.length} quiz results`);

    // Create quiz lookup map
    const quizMap = {};
    quizzes.forEach(quiz => {
      quizMap[quiz._id.toString()] = quiz;
    });

    // Create lecture lookup map
    const lectureMap = {};
    lectures.forEach(lecture => {
      lectureMap[lecture._id.toString()] = lecture;
    });

    // 📈 CALCULATE BASIC STATS
    const totalQuizzes = quizzes.length;
    const totalResults = results.length;
    
    // Get unique students who took quizzes
    const uniqueStudents = [...new Set(results.map(r => r.studentId.toString()))];
    const totalStudents = uniqueStudents.length;

    // Calculate average score (safe)
    let totalScore = 0;
    let validScores = 0;
    
    results.forEach(result => {
      const score = safeNumber(result.percentage);
      if (score >= 0 && score <= 100) {
        totalScore += score;
        validScores++;
      }
    });

    const averageScore = validScores > 0 ? totalScore / validScores : 0;
    console.log(`📊 Basic stats: ${totalStudents} students, avg score: ${safeToFixed(averageScore)}%`);

    // 🎯 PERFORMANCE DISTRIBUTION DATA
    const performanceDistribution = [];
    const quizPerformanceMap = {};

    // Group results by quiz
    results.forEach(result => {
      const quizId = result.quizId.toString();
      if (!quizPerformanceMap[quizId]) {
        quizPerformanceMap[quizId] = [];
      }
      quizPerformanceMap[quizId].push(safeNumber(result.percentage));
    });

    // Calculate performance distribution for each quiz
    Object.keys(quizPerformanceMap).forEach(quizId => {
      const quiz = quizMap[quizId];
      const scores = quizPerformanceMap[quizId];
      
      if (quiz && scores.length > 0) {
        const excellent = scores.filter(s => s >= 90).length;
        const good = scores.filter(s => s >= 70 && s < 90).length;
        const average = scores.filter(s => s >= 50 && s < 70).length;
        const needsHelp = scores.filter(s => s < 50).length;
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        
        const lecture = lectureMap[quiz.lectureId.toString()];
        const lectureTitle = lecture ? lecture.title : 'Unknown Lecture';
        
        performanceDistribution.push({
          quizTitle: quiz.lectureTitle && quiz.lectureTitle.length > 20 ? quiz.lectureTitle.substring(0, 20) + '...' : (quiz.lectureTitle || 'Quiz'),
          fullTitle: `${lectureTitle} - ${quiz.lectureTitle || 'Quiz'}`,
          excellent,
          good,
          average,
          needsHelp,
          totalParticipants: scores.length,
          averageScore: safeToFixed(avgScore, 1)
        });
      }
    });

    console.log(`📊 Performance distribution calculated for ${performanceDistribution.length} quizzes`);

    // 📊 ENGAGEMENT LEVELS DATA
    const studentEngagement = {};
    
    // Calculate engagement for each student
    uniqueStudents.forEach(studentId => {
      const studentResults = results.filter(r => r.studentId.toString() === studentId);
      const participationRate = (studentResults.length / totalQuizzes) * 100;
      
      studentEngagement[studentId] = {
        participationRate: safeNumber(participationRate),
        totalQuizzes: studentResults.length,
        averageScore: studentResults.length > 0 
          ? studentResults.reduce((sum, r) => sum + safeNumber(r.percentage), 0) / studentResults.length 
          : 0
      };
    });

    // Categorize students by engagement
    const engagementLevels = {
      highlyActive: 0,      // 80%+ participation
      moderatelyActive: 0,  // 50-79% participation
      lowActivity: 0,       // 20-49% participation
      inactive: 0           // <20% participation
    };

    Object.values(studentEngagement).forEach(engagement => {
      const rate = engagement.participationRate;
      if (rate >= 80) engagementLevels.highlyActive++;
      else if (rate >= 50) engagementLevels.moderatelyActive++;
      else if (rate >= 20) engagementLevels.lowActivity++;
      else engagementLevels.inactive++;
    });

    console.log(`📊 Engagement levels calculated`);

    // 🏆 TOP PERFORMERS AND INSIGHTS
    const studentPerformance = {};
    
    results.forEach(result => {
      const studentId = result.studentId.toString();
      const score = safeNumber(result.percentage);
      const studentName = result.studentName || `Student ${studentId.slice(-4)}`;
      
      if (!studentPerformance[studentId]) {
        studentPerformance[studentId] = {
          studentId,
          studentName,
          totalScore: 0,
          quizCount: 0,
          scores: [],
          totalTime: 0
        };
      }
      
      studentPerformance[studentId].totalScore += score;
      studentPerformance[studentId].quizCount++;
      studentPerformance[studentId].scores.push(score);
      studentPerformance[studentId].totalTime += safeNumber(result.timeTakenSeconds, 0);
    });

    // Calculate student rankings
    const rankedStudents = Object.values(studentPerformance)
      .map((student, index) => ({
        rank: index + 1, // Will be recalculated after sorting
        studentId: student.studentId,
        studentName: student.studentName,
        averageScore: student.quizCount > 0 ? safeToFixed(student.totalScore / student.quizCount, 1) : '0.0',
        totalQuizzes: student.quizCount,
        averageTime: student.quizCount > 0 ? formatTime(student.totalTime / student.quizCount) : '0:00',
        participationRate: safeToFixed(safePercentage(student.quizCount, totalQuizzes), 1)
      }))
      .sort((a, b) => safeNumber(b.averageScore) - safeNumber(a.averageScore))
      .map((student, index) => ({ ...student, rank: index + 1 }));

    // Top 5 performers for insights
    const topPerformers = rankedStudents.slice(0, 5);

    // Students needing attention (low participation or low scores)
    const studentsNeedingAttention = rankedStudents
      .filter(student => 
        safeNumber(student.averageScore) < 60 || 
        safeNumber(student.participationRate) < 50
      )
      .slice(0, 5);

    // Quiz insights
    const mostChallengingQuiz = performanceDistribution.length > 0 ? 
      performanceDistribution.sort((a, b) => safeNumber(a.averageScore) - safeNumber(b.averageScore))[0] : null;
    
    const bestPerformingQuiz = performanceDistribution.length > 0 ? 
      performanceDistribution.sort((a, b) => safeNumber(b.averageScore) - safeNumber(a.averageScore))[0] : null;

    console.log(`🏆 Student rankings calculated: ${rankedStudents.length} students`);

    // 📅 RECENT ACTIVITY (Last 10 submissions)
    const recentActivity = results
      .sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate))
      .slice(0, 10)
      .map(result => {
        const quiz = quizMap[result.quizId.toString()];
        const lecture = quiz ? lectureMap[quiz.lectureId.toString()] : null;
        
        return {
          studentName: result.studentName || 'Unknown Student',
          quizTitle: quiz ? 
            (quiz.lectureTitle && quiz.lectureTitle.length > 30 ? quiz.lectureTitle.substring(0, 30) + '...' : quiz.lectureTitle || 'Quiz') 
            : 'Unknown Quiz',
          fullQuizTitle: quiz ? `${lecture?.title || 'Unknown'} - ${quiz.lectureTitle || 'Quiz'}` : 'Unknown Quiz',
          score: safeToFixed(result.percentage, 1),
          submissionDate: new Date(result.submissionDate).toLocaleDateString(),
          timeTaken: formatTime(result.timeTakenSeconds)
        };
      });

    // 🎯 QUIZ PERFORMANCE SUMMARY
    const quizPerformance = performanceDistribution.map(quiz => ({
      quizTitle: quiz.quizTitle,
      fullTitle: quiz.fullTitle,
      participants: quiz.totalParticipants,
      averageScore: quiz.averageScore,
      highestScore: safeToFixed(Math.max(...(quizPerformanceMap[Object.keys(quizMap).find(id => 
        (quizMap[id].lectureTitle === quiz.quizTitle) || 
        quiz.fullTitle.includes(quizMap[id].lectureTitle || '')
      )] || [0])), 1),
      lowestScore: safeToFixed(Math.min(...(quizPerformanceMap[Object.keys(quizMap).find(id => 
        (quizMap[id].lectureTitle === quiz.quizTitle) || 
        quiz.fullTitle.includes(quizMap[id].lectureTitle || '')
      )] || [0])), 1)
    }));

    // 📊 CLASS HEALTH METRICS
    const classHealthScore = {
      engagement: safeToFixed(safePercentage(
        engagementLevels.highlyActive + engagementLevels.moderatelyActive, 
        totalStudents
      ), 1),
      performance: safeToFixed(averageScore, 1),
      participation: safeToFixed(safePercentage(
        rankedStudents.filter(s => safeNumber(s.participationRate) >= 50).length,
        totalStudents
      ), 1)
    };

    // 🎨 CHART METADATA
    const chartMetadata = {
      performanceChart: {
        title: '📊 Student Performance Distribution by Quiz',
        subtitle: 'Number of students in each performance category per quiz',
        colors: {
          excellent: '#10b981',
          good: '#3b82f6',
          average: '#f59e0b',
          needsHelp: '#ef4444'
        }
      },
      engagementChart: {
        title: '👥 Student Engagement Levels',
        subtitle: 'Based on quiz participation rates',
        colors: {
          highlyActive: '#10b981',
          moderatelyActive: '#3b82f6',
          lowActivity: '#f59e0b',
          inactive: '#ef4444'
        }
      }
    };

    // 🎯 FINAL ENHANCED ANALYTICS DATA
    const enhancedAnalyticsData = {
      overallStats: {
        totalStudents,
        totalQuizzes,
        classAverage: safeToFixed(averageScore, 1),
        totalResults
      },
      performanceDistribution,
      engagementLevels,
      insights: {
        classHealthScore,
        topPerformers: topPerformers.map(p => ({ ...p, rank: p.rank })),
        studentsNeedingAttention,
        mostChallengingQuiz,
        bestPerformingQuiz
      },
      rankedStudents,
      recentActivity,
      quizPerformance,
      chartMetadata
    };

    console.log('✅ Enhanced analytics calculation completed successfully');
    console.log('📊 Analytics summary:', {
      totalStudents: enhancedAnalyticsData.overallStats.totalStudents,
      totalQuizzes: enhancedAnalyticsData.overallStats.totalQuizzes,
      classAverage: enhancedAnalyticsData.overallStats.classAverage,
      performanceQuizzes: enhancedAnalyticsData.performanceDistribution.length,
      rankedStudents: enhancedAnalyticsData.rankedStudents.length,
      recentActivity: enhancedAnalyticsData.recentActivity.length
    });

    res.json({
      success: true,
      data: enhancedAnalyticsData
    });

  } catch (error) {
    console.error('❌ Enhanced analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate enhanced analytics',
      error: error.message
    });
  }
});

// Individual Student Analytics for Teachers
// 🔄 REPLACE your existing /api/teacher/student-analytics/:studentId route with this enhanced version:

app.get('/api/teacher/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const studentId = req.params.studentId;
        const classId = req.query.classId; // Optional class filter
        const teacherId = req.session.userId;
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

        console.log('📊 Loading student analytics API:', {
            studentId: studentId,
            classId: classId,
            teacherId: teacherId
        });

        // Get student info
        const student = await studentCollection.findById(studentId).select('name enrollment').lean();
        if (!student) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        // 🆕 NEW: Build query filter based on class context
        let quizResultsFilter = {
            studentId: studentId,
            submissionDate: { $gte: fifteenDaysAgo }
        };

        let classAverageFilter = {
            submissionDate: { $gte: fifteenDaysAgo }
        };

        // 🏫 Apply class filtering if specified
        if (classId) {
            // Verify teacher access to class
            const classDoc = await classCollection.findOne({
                _id: classId,
                teacherId: teacherId,
                isActive: true
            }).lean();

            if (!classDoc) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Class not found or access denied.' 
                });
            }

            // Verify student enrollment
            const enrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: classId,
                isActive: true
            }).lean();

            if (!enrollment) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Student is not enrolled in this class.' 
                });
            }

            // Filter by specific class
            quizResultsFilter.classId = classId;
            classAverageFilter.classId = classId;

            console.log(`🏫 Filtering analytics for class: ${classDoc.name}`);
        } else {
            // 🔍 Verify teacher has access to student through any class
            const teacherClasses = await classCollection.find({
                teacherId: teacherId,
                isActive: true
            }).select('_id').lean();

            const teacherClassIds = teacherClasses.map(c => c._id);

            const studentEnrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: { $in: teacherClassIds },
                isActive: true
            }).lean();

            if (!studentEnrollment) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'You do not have access to this student\'s analytics.' 
                });
            }

            // Filter by teacher's classes only
            classAverageFilter.classId = { $in: teacherClassIds };
            quizResultsFilter.classId = { $in: teacherClassIds };

            console.log('📊 Loading analytics across all teacher\'s classes');
        }

        // 📊 Get student's quiz results (filtered)
        const studentResults = await quizResultCollection
            .find(quizResultsFilter)
            .sort({ submissionDate: -1 })
            .lean();

        // 📈 Get class average for comparison (filtered)
        const allClassResults = await quizResultCollection
            .find(classAverageFilter)
            .lean();

        // 🔄 Enhanced: Get quiz details with class information
        const enhancedStudentResults = await Promise.all(
            studentResults.map(async (result) => {
                const quiz = await quizCollection.findById(result.quizId).select('lectureTitle classId').lean();
                const classInfo = quiz && quiz.classId ? await classCollection.findById(quiz.classId).select('name').lean() : null;
                
                return {
                    ...result,
                    quizTitle: quiz ? quiz.lectureTitle : 'Unknown Quiz',
                    className: classInfo ? classInfo.name : 'Unknown Class'
                };
            })
        );

        // Calculate statistics
        const totalQuizzes = studentResults.length;
        const averageScore = totalQuizzes > 0 
            ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
            : 0;

        // Calculate class average (filtered by same criteria)
        const classScores = allClassResults.map(r => r.percentage);
        const classAverage = classScores.length > 0 
            ? (classScores.reduce((sum, score) => sum + score, 0) / classScores.length).toFixed(1)
            : 0;

        // Calculate improvement trend
        let trendIndicator = '→';
        if (studentResults.length >= 6) {
            const recent3 = studentResults.slice(0, 3).reduce((sum, r) => sum + r.percentage, 0) / 3;
            const previous3 = studentResults.slice(3, 6).reduce((sum, r) => sum + r.percentage, 0) / 3;
            
            if (recent3 > previous3 + 5) trendIndicator = '↗️';
            else if (recent3 < previous3 - 5) trendIndicator = '↘️';
        }

        // Calculate average time
        const averageTime = totalQuizzes > 0 
            ? Math.floor(studentResults.reduce((sum, result) => sum + result.timeTakenSeconds, 0) / totalQuizzes / 60)
            : 0;

        // 📊 Prepare trend data for charts
        const trendData = enhancedStudentResults.reverse().map(result => ({
            date: result.submissionDate.toLocaleDateString(),
            score: result.percentage,
            classAvg: parseFloat(classAverage) // Use filtered class average
        }));

        // 📋 Format detailed results (limit to 10 most recent)
        const detailedResults = enhancedStudentResults.slice(0, 10).map(result => ({
            quizTitle: result.quizTitle,
            score: result.score,
            totalQuestions: result.totalQuestions,
            percentage: result.percentage,
            timeTaken: result.timeTakenSeconds,
            submissionDate: result.submissionDate,
            className: result.className,
            answers: result.answers
        }));

        // 📈 Prepare time analysis data
        const timeAnalysisData = enhancedStudentResults.slice(0, 10).map(result => ({
            quiz: result.quizTitle,
            timeMinutes: Math.floor(result.timeTakenSeconds / 60)
        }));

        // 🎯 ENHANCED: Return class-aware analytics data
        const analyticsData = {
            studentInfo: {
                name: student.name,
                enrollment: student.enrollment,
                studentId: studentId
            },
            performanceMetrics: {
                totalQuizzes,
                averageScore: parseFloat(averageScore),
                classAverage: parseFloat(classAverage),
                averageTime: averageTime + 'm',
                trendIndicator
            },
            detailedResults,
            chartData: {
                scoresTrend: trendData,
                timeAnalysis: timeAnalysisData
            },
            // 🆕 NEW: Include class context in response
            classContext: {
                hasClassFilter: !!classId,
                classId: classId,
                totalResultsFound: studentResults.length
            }
        };

        console.log(`📊 Analytics data prepared for ${student.name}:`, {
            totalQuizzes: analyticsData.performanceMetrics.totalQuizzes,
            averageScore: analyticsData.performanceMetrics.averageScore,
            classFiltered: !!classId
        });

        res.json({
            success: true,
            data: analyticsData
        });

    } catch (error) {
        console.error('❌ Error fetching student analytics:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load student analytics.' 
        });
    }
});



// 🆕 NEW: Add this route to index.js for class-context student analytics access

// Class-specific student analytics route
app.get('/class/:classId/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const { classId, studentId } = req.params;
        const teacherId = req.session.userId;

        console.log('🏫 Class-context student analytics access:', {
            classId: classId,
            studentId: studentId,
            teacherId: teacherId
        });

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(403).redirect('/homeTeacher?message=Class not found or access denied.');
        }

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        }).lean();

        if (!enrollment) {
            return res.status(403).redirect(`/class/manage/${classId}?message=Student not found in this class.`);
        }

        console.log(`✅ Redirecting to analytics for ${enrollment.studentName} in ${classDoc.name}`);

        // Redirect to student analytics with class context
        res.redirect(`/teacher/student-analytics/${studentId}?classId=${classId}`);

    } catch (error) {
        console.error('❌ Error accessing class student analytics:', error);
        res.status(500).redirect('/homeTeacher?message=Failed to access student analytics.');
    }
});

// Student Analytics Page for Teachers
// 🔄 REPLACE your existing /teacher/student-analytics/:studentId route with this enhanced version:

app.get('/teacher/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const studentId = req.params.studentId;
        const classId = req.query.classId; // Optional class context
        const teacherId = req.session.userId;

        console.log('📊 Loading student analytics page:', {
            studentId: studentId,
            classId: classId,
            teacherId: teacherId,
            requestedBy: req.session.userName
        });

        // Get student info
        const student = await studentCollection.findById(studentId).select('name enrollment').lean();
        if (!student) {
            return res.status(404).send('Student not found.');
        }

        // 🆕 NEW: Class context verification and data
        let classContext = {
            classId: null,
            className: null,
            hasAccess: false
        };

        if (classId) {
            // Verify teacher owns the class
            const classDoc = await classCollection.findOne({
                _id: classId,
                teacherId: teacherId,
                isActive: true
            }).lean();

            if (classDoc) {
                // Verify student is enrolled in this class
                const enrollment = await classStudentCollection.findOne({
                    studentId: studentId,
                    classId: classId,
                    isActive: true
                }).lean();

                if (enrollment) {
                    classContext = {
                        classId: classId,
                        className: classDoc.name,
                        hasAccess: true
                    };
                    console.log('✅ Class context verified:', classContext.className);
                } else {
                    console.log('⚠️ Student not enrolled in specified class');
                    return res.status(403).send('Student is not enrolled in this class.');
                }
            } else {
                console.log('⚠️ Class not found or access denied');
                return res.status(403).send('Class not found or access denied.');
            }
        } else {
            // 🔍 Check if teacher has access to student through any class
            const teacherClasses = await classCollection.find({
                teacherId: teacherId,
                isActive: true
            }).select('_id').lean();

            const teacherClassIds = teacherClasses.map(c => c._id);

            const studentEnrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: { $in: teacherClassIds },
                isActive: true
            }).lean();

            if (!studentEnrollment) {
                return res.status(403).send('You do not have access to this student\'s analytics.');
            }

            console.log('✅ Teacher access to student verified through class enrollment');
        }

        console.log(`📊 Rendering analytics page for ${student.name}${classContext.className ? ` (${classContext.className})` : ''}`);

        // 🎯 ENHANCED: Pass complete class context to template
        res.render('studentAnalytics', {
            student: student,
            studentId: studentId,
            userName: req.session.userName,
            classContext: classContext // 🆕 NEW: Pass class context
        });

    } catch (error) {
        console.error('❌ Error rendering student analytics page:', error);
        res.status(500).send('Failed to load student analytics page.');
    }
});

// ==================== AI EXPLANATIONS ROUTES ====================

// Enhanced explanation retrieval route
app.post('/api/explanation/get', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const { quizId, questionIndex, wrongAnswer } = req.body;

        console.log('🔍 Getting ENHANCED explanation for:', {
            quizId: quizId,
            questionIndex: questionIndex,
            wrongAnswer: wrongAnswer
        });

        // Get the quiz with enhanced explanations
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        const question = quiz.questions[questionIndex];
        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found.' });
        }

        let explanation = null;
        let explanationType = 'detailed';

        // Get the detailed explanation for the wrong answer
        if (question.explanations && question.explanations[wrongAnswer] && question.explanations[wrongAnswer].trim() !== '') {
            explanation = question.explanations[wrongAnswer];
            
            // Also include context about the correct answer
            if (question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '') {
                explanation += `\n\n💡 **Why ${question.correct_answer} is correct:** ${question.correctAnswerExplanation}`;
            }
            
            console.log('✅ Retrieved detailed explanation for wrong answer:', wrongAnswer);
        } else {
            // Fallback explanation if detailed ones aren't available
            explanationType = 'basic';
            if (question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '') {
                explanation = `The correct answer is ${question.correct_answer}) ${question.options[question.correct_answer]}.\n\n${question.correctAnswerExplanation}`;
            } else {
                explanation = `The correct answer is ${question.correct_answer}) ${question.options[question.correct_answer]}. Please review the lecture material for detailed understanding.`;
            }
            
            console.log('⚠️ Using fallback explanation - detailed explanation not found');
        }

        console.log('✅ Retrieved explanation:', {
            type: explanationType,
            length: explanation.length,
            preview: explanation.substring(0, 100) + '...'
        });

        res.json({
            success: true,
            explanation: explanation,
            cached: true,
            source: 'pre-generated-enhanced',
            explanationType: explanationType,
            questionDetails: {
                correctAnswer: question.correct_answer,
                correctOption: question.options[question.correct_answer],
                wrongOption: question.options[wrongAnswer],
                hasDetailedExplanations: !!(question.explanations && Object.keys(question.explanations).length > 0),
                hasCorrectExplanation: !!(question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '')
            }
        });

    } catch (error) {
        console.error('❌ Error retrieving enhanced explanation:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to retrieve explanation: ' + error.message 
        });
    }
});

// Check explanation status for a quiz
app.get('/api/quiz/:quizId/explanations-status', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const quiz = await quizCollection.findById(quizId).select('questions generatedDate').lean();
        
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        // Check if questions have enhanced explanations
        const questionsWithExplanations = quiz.questions.filter(q => 
            q.explanations && Object.keys(q.explanations).some(key => q.explanations[key] && q.explanations[key].trim() !== '')
        ).length;

        const questionsWithCorrectExplanations = quiz.questions.filter(q => 
            q.correctAnswerExplanation && q.correctAnswerExplanation.trim() !== ''
        ).length;

        const hasEnhancedExplanations = questionsWithExplanations > 0;

        console.log('📊 Explanation status check:', {
            quizId: quizId,
            totalQuestions: quiz.questions.length,
            questionsWithExplanations: questionsWithExplanations,
            questionsWithCorrectExplanations: questionsWithCorrectExplanations,
            hasEnhancedExplanations: hasEnhancedExplanations
        });

        res.json({
            success: true,
            hasEnhancedExplanations: hasEnhancedExplanations,
            explanationStats: {
                totalQuestions: quiz.questions.length,
                questionsWithExplanations: questionsWithExplanations,
                questionsWithCorrectExplanations: questionsWithCorrectExplanations,
                enhancementLevel: questionsWithExplanations === quiz.questions.length ? 'full' : 
                                questionsWithExplanations > 0 ? 'partial' : 'none'
            },
            generatedDate: quiz.generatedDate
        });

    } catch (error) {
        console.error('❌ Error checking explanation status:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to check explanation status: ' + error.message 
        });
    }
});

// ==================== DEBUG ROUTES (Development Only) ====================

// Debug route to check quiz explanations structure
app.get('/debug/quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        console.log('🔍 DEBUG: Checking quiz explanations for:', quizId);
        
        const quiz = await quizCollection.findById(quizId).lean();
        
        if (!quiz) {
            return res.json({ error: 'Quiz not found' });
        }

        // Check the structure of the first question
        const firstQuestion = quiz.questions[0];
        
        const debugInfo = {
            quizId: quiz._id,
            lectureTitle: quiz.lectureTitle,
            totalQuestions: quiz.questions.length,
            generatedDate: quiz.generatedDate,
            
            // Check first question structure
            firstQuestionStructure: {
                hasQuestion: !!firstQuestion.question,
                hasOptions: !!firstQuestion.options,
                hasCorrectAnswer: !!firstQuestion.correct_answer,
                hasExplanations: !!firstQuestion.explanations,
                hasCorrectExplanation: !!firstQuestion.correctAnswerExplanation,
                
                // Show actual explanation data
                explanationsData: firstQuestion.explanations || 'NOT FOUND',
                correctExplanationData: firstQuestion.correctAnswerExplanation || 'NOT FOUND'
            },
            
            // Check all questions for explanations
            questionsWithExplanations: quiz.questions.filter(q => 
                q.explanations && Object.keys(q.explanations).length > 0
            ).length,
            
            questionsWithCorrectExplanations: quiz.questions.filter(q => 
                q.correctAnswerExplanation && q.correctAnswerExplanation.trim() !== ''
            ).length,
            
            // Sample of explanations from first question
            sampleExplanations: firstQuestion.explanations ? 
                Object.entries(firstQuestion.explanations).map(([key, value]) => ({
                    option: key,
                    explanation: value ? value.substring(0, 100) + '...' : 'EMPTY'
                })) : 'NO EXPLANATIONS FIELD'
        };

        console.log('📊 DEBUG Results:', debugInfo);
        
        res.json({
            success: true,
            debugInfo: debugInfo,
            recommendation: debugInfo.questionsWithExplanations === 0 ? 
                'ISSUE FOUND: No questions have explanations. You need to generate a NEW quiz with the enhanced system.' :
                'Explanations found! Check the explanation retrieval route.'
        });

    } catch (error) {
        console.error('❌ Debug error:', error);
        res.json({ error: error.message });
    }
});

// Debug route to test a specific question's explanations
app.get('/debug/quiz/:quizId/question/:questionIndex', isAuthenticated, async (req, res) => {
    try {
        const { quizId, questionIndex } = req.params;
        
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.json({ error: 'Quiz not found' });
        }

        const question = quiz.questions[parseInt(questionIndex)];
        if (!question) {
            return res.json({ error: 'Question not found' });
        }

        res.json({
            success: true,
            questionDebug: {
                questionText: question.question,
                options: question.options,
                correctAnswer: question.correct_answer,
                hasExplanations: !!question.explanations,
                explanations: question.explanations || 'NOT FOUND',
                hasCorrectExplanation: !!question.correctAnswerExplanation,
                correctExplanation: question.correctAnswerExplanation || 'NOT FOUND',
                
                // Test each wrong answer explanation
                explanationTests: ['A', 'B', 'C', 'D'].map(option => ({
                    option: option,
                    isCorrectAnswer: option === question.correct_answer,
                    hasExplanation: !!(question.explanations && question.explanations[option]),
                    explanationText: question.explanations && question.explanations[option] ? 
                        question.explanations[option] : 'NO EXPLANATION'
                }))
            }
        });

    } catch (error) {
        console.error('❌ Question debug error:', error);
        res.json({ error: error.message });
    }
});

// ==================== QUIZ RESULTS PAGE ROUTE ====================

// 🔄 OPTIONAL: Replace your existing /quiz-results route with this enhanced version:

app.get('/quiz-results', isAuthenticated, (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Only students can view quiz results.');
        }

        // 🆕 ENHANCED: Handle query parameters for better error handling
        const queryParams = {
            alreadyTaken: req.query.alreadyTaken === 'true',
            quizTitle: req.query.quizTitle || null,
            error: req.query.error || null,
            message: req.query.message || null
        };

        console.log('📊 Quiz results page accessed:', {
            student: req.session.userName,
            queryParams: queryParams
        });

        // 🎯 ENHANCED: Pass additional context for better error handling
        res.render('quizResults', {
            userName: req.session.userName || 'Student',
            userType: req.session.userType || 'student',
            queryParams: queryParams, // Pass query parameters to template
            // Note: Main quiz data comes from localStorage, set by takeQuiz.hbs
        });

    } catch (error) {
        console.error('❌ Error rendering quiz results page:', error);
        res.status(500).send('Failed to load quiz results page.');
    }
});

// ==================== DATA CLEANUP FUNCTIONS ====================

// Function to clean up old quiz results (older than 15 days)
async function cleanupOldQuizResults() {
    try {
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
        
        const deleteResult = await quizResultCollection.deleteMany({
            submissionDate: { $lt: fifteenDaysAgo }
        });
        
        console.log(`🗑️ Cleaned up ${deleteResult.deletedCount} old quiz results (older than 15 days)`);
        
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    }
}

// Function to clean up old unused explanations (run monthly)
async function cleanupOldExplanations() {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        
        // Delete explanations that haven't been used in 30 days and have usage count of 1
        const deleteResult = await explanationCacheCollection.deleteMany({
            generatedDate: { $lt: thirtyDaysAgo },
            usageCount: 1
        });
        
        console.log(`🗑️ Cleaned up ${deleteResult.deletedCount} unused explanations`);
        
    } catch (error) {
        console.error('❌ Error during explanation cleanup:', error);
    }
}

// ==================== ERROR HANDLING ====================

app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
            const message = encodeURIComponent('File too large. Maximum size is 100MB.');
            return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
        }
        const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
        const message = encodeURIComponent('File upload error: ' + error.message);
        return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
    }

    if (req.fileError) {
        const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
        const message = encodeURIComponent(req.fileError.message);
        return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
    }

    next(error)
})

// ==================== SERVER STARTUP ====================

app.listen(PORT, () => {
    console.log(`🚀 QuizAI Server started on port ${PORT}`)
    console.log(`📌 Open http://localhost:${PORT} in your browser`)

    // Run cleanup functions on server start
    cleanupTempFiles()
    cleanupOldQuizResults()

    console.log('✅ Server initialization complete!')
    console.log('📚 Ready to process lecture uploads and generate enhanced quizzes!')
    console.log(`🔑 Using Gemini model: gemini-1.5-flash (Free tier)`)
})

// Schedule cleanup functions to run periodically
setInterval(cleanupOldQuizResults, 24 * 60 * 60 * 1000); // Every 24 hours
setInterval(cleanupOldExplanations, 15 * 24 * 60 * 60 * 1000); // Every 15 days

// 🛠️ HELPER FUNCTIONS (Add these at the bottom of your index.js file)

function getEmptyAnalyticsData() {
  return {
    overallStats: {
      totalStudents: 0,
      totalQuizzes: 0,
      classAverage: '0.0',
      totalResults: 0
    },
    performanceDistribution: [],
    engagementLevels: {
      highlyActive: 0,
      moderatelyActive: 0,
      lowActivity: 0,
      inactive: 0
    },
    insights: {
      classHealthScore: {
        engagement: '0.0',
        performance: '0.0',
        participation: '0.0'
      },
      topPerformers: [],
      studentsNeedingAttention: [],
      mostChallengingQuiz: null,
      bestPerformingQuiz: null
    },
    rankedStudents: [],
    recentActivity: [],
    quizPerformance: [],
    chartMetadata: {
      performanceChart: {
        title: '📊 Student Performance Distribution by Quiz',
        subtitle: 'No data available yet',
        colors: {
          excellent: '#10b981',
          good: '#3b82f6',
          average: '#f59e0b',
          needsHelp: '#ef4444'
        }
      },
      engagementChart: {
        title: '👥 Student Engagement Levels',
        subtitle: 'No data available yet',
        colors: {
          highlyActive: '#10b981',
          moderatelyActive: '#3b82f6',
          lowActivity: '#f59e0b',
          inactive: '#ef4444'
        }
      }
    }
  };
}

function formatTime(seconds) {
  const totalSeconds = safeNumber(seconds, 0);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}