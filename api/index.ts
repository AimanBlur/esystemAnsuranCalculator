import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import nodemailer from 'nodemailer';
import postgres from 'postgres';

let sql: any;
try {
    if (!process.env.DATABASE_URL) {
        console.error("❌ ERROR: DATABASE_URL is missing!");
    } else {
        console.log("🔌 Connecting to database...");
        sql = postgres(process.env.DATABASE_URL, { 
            ssl: 'require', 
            prepare: false 
        });
        console.log("✅ Database connected successfully");
    }
} catch (err) {
    console.error("❌ Database Connection Failed:", err);
}

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 465,
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

const app = new Elysia()
    .use(cors())
    .group('/api', app => app

        .post('/audits', async ({ body, set }) => {
            if (!sql) { 
                console.error("Audit POST - DB not connected");
                set.status = 500; 
                return { success: false, message: "DB Error" }; 
            }
            const b = body as any;
            try {
                await sql`
                    INSERT INTO audits (
                        staff_name, staff_branch, date_received, model, storage_color, serial_number, imei,
                        icloud_lock, device_erased, mdm_lock, imei_status, sim_lock, battery_health,
                        charging_test, screen_condition, back_glass, frame_condition, biometrics,
                        camera_condition, audio_condition, connectivity, non_genuine_parts, accessories,
                        grade, remarks
                    ) VALUES (
                        ${b.staff_name}, ${b.staff_branch}, ${b.date_received}, ${b.model}, ${b.storage_color}, ${b.serial_number}, ${b.imei},
                        ${b.icloud_lock}, ${b.device_erased}, ${b.mdm_lock}, ${b.imei_status}, ${b.sim_lock}, ${b.battery_health},
                        ${b.charging_test}, ${b.screen_condition}, ${b.back_glass}, ${b.frame_condition}, ${b.biometrics},
                        ${b.camera_condition}, ${b.audio_condition}, ${b.connectivity}, ${b.non_genuine_parts}, ${b.accessories},
                        ${b.grade}, ${b.remarks}
                    )
                `;
                return { success: true };
            } catch (e: any) { 
                console.error("Audit POST error:", e);
                return { success: false, message: e.message }; 
            }
        })

        .get('/audits', async ({ headers, set }) => {
            if (!sql) {
                console.error("Audits GET - DB not connected");
                return [];
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return []; 
            }
            try {
                const audits = await sql`SELECT * FROM audits ORDER BY created_at DESC LIMIT 50`;
                return [...audits];
            } catch (e) { 
                console.error("Audits GET error:", e);
                return []; 
            }
        })

        .post('/login', async ({ body, set }) => {
            if (!sql) { 
                console.error("Login - DB not connected");
                set.status = 500; 
                return { success: false, message: "DB Disconnected" }; 
            }
            try {
                const users = await sql`SELECT * FROM users WHERE username = ${body.username} AND password = ${body.password}`;
                if (users.length > 0) {
                    return { 
                        success: true, 
                        id: users[0].id,
                        role: users[0].role, 
                        username: users[0].username, 
                        name: users[0].name, 
                        branch: users[0].branch 
                    }; 
                }
                set.status = 401; 
                return { success: false, message: "Invalid ID or Password" };
            } catch (e: any) { 
                console.error("Login error:", e);
                return { success: false, message: e.message }; 
            }
        }, { body: t.Object({ username: t.String(), password: t.String() }) })

        // GET USERS - PUBLIC (for request dropdown)
        .get('/users', async ({ set }) => {
            if (!sql) {
                console.error("Users GET - DB not connected");
                set.status = 500;
                return [];
            }
            try {
                const users = await sql`SELECT id, name, branch FROM users ORDER BY name ASC`;
                return [...users];
            } catch (e) { 
                console.error("Users GET error:", e);
                set.status = 500;
                return []; 
            }
        })

        // GET ALL USERS (Admin Only)
        .get('/users/admin', async ({ headers, set }) => {
            if (!sql) return [];
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return []; 
            }
            try {
                const users = await sql`SELECT id, username, role, name, branch FROM users ORDER BY id ASC`;
                return [...users];
            } catch (e) { 
                console.error("Users Admin GET error:", e);
                return []; 
            }
        })

        .put('/users/:id/password', async ({ params, body, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false };
            }
            try {
                await sql`UPDATE users SET password = ${body.password} WHERE id = ${params.id}`;
                return { success: true };
            } catch (e: any) {
                console.error("Password update error:", e);
                set.status = 500;
                return { success: false, message: e.message };
            }
        }, { body: t.Object({ password: t.String() }) })

        // --- REQUESTS SYSTEM ---
        
        .get('/requests/:userId', async ({ params, set }) => {
            if (!sql) {
                console.error("Requests GET - DB not connected");
                set.status = 500;
                return { received: [], sent: [] };
            }
            try {
                const received = await sql`SELECT * FROM requests WHERE receiver_id = ${params.userId} ORDER BY created_at DESC`;
                const sent = await sql`SELECT r.*, u.name as receiver_name FROM requests r LEFT JOIN users u ON r.receiver_id = u.id WHERE sender_id = ${params.userId} ORDER BY created_at DESC`;
                return { received: [...received], sent: [...sent] };
            } catch (e) {
                console.error("Requests GET error:", e);
                set.status = 500;
                return { received: [], sent: [] };
            }
        })

        .get('/requests/:userId/pending-count', async ({ params, set }) => {
            if (!sql) {
                set.status = 500;
                return { count: 0 };
            }
            try {
                const result = await sql`SELECT COUNT(*) as count FROM requests WHERE receiver_id = ${params.userId} AND status = 'pending'`;
                return { count: parseInt(result[0]?.count) || 0 };
            } catch (e) {
                console.error("Pending count error:", e);
                return { count: 0 };
            }
        })

        .post('/requests', async ({ body, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false };
            }
            try {
                await sql`
                    INSERT INTO requests (sender_id, sender_name, receiver_id, content) 
                    VALUES (${body.sender_id}, ${body.sender_name}, ${body.receiver_id}, ${body.content})
                `;
                return { success: true };
            } catch (e: any) {
                console.error("Request POST error:", e);
                set.status = 500;
                return { success: false, message: e.message };
            }
        }, { body: t.Object({ sender_id: t.Number(), sender_name: t.String(), receiver_id: t.Number(), content: t.String() }) })

        .put('/requests/:id/status', async ({ params, body, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false };
            }
            try {
                await sql`UPDATE requests SET status = ${body.status} WHERE id = ${params.id}`;
                return { success: true };
            } catch (e: any) {
                console.error("Request status update error:", e);
                set.status = 500;
                return { success: false, message: e.message };
            }
        }, { body: t.Object({ status: t.String() }) })

        .post('/users', async ({ body, headers, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB Error" };
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return { success: false }; 
            }
            try {
                const b = body as any;
                await sql`
                    INSERT INTO users (username, password, role, name, branch) 
                    VALUES (${b.username}, ${b.password}, 'staff', ${b.name}, ${b.branch})
                `;
                return { success: true };
            } catch (e: any) { 
                console.error("User creation error:", e);
                return { success: false, message: e.message }; 
            }
        })

        .delete('/users/:id', async ({ params, headers, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false };
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return { success: false }; 
            }
            try {
                await sql`DELETE FROM users WHERE id = ${params.id}`;
                return { success: true };
            } catch (e: any) {
                console.error("User deletion error:", e);
                set.status = 500;
                return { success: false, message: e.message };
            }
        })

        .put('/users/:id', async ({ params, body, headers, set }) => {
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return { success: false, message: "Unauthorized" }; 
            }
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB Error" };
            }
            
            const b = body as any;
            try {
                await sql`UPDATE users SET password = ${b.password} WHERE id = ${params.id}`;
                return { success: true };
            } catch (e: any) { 
                console.error("User update error:", e);
                return { success: false, message: e.message }; 
            }
        }, { body: t.Object({ password: t.String() }) })
        
        // ROUTE 1: Get All Phones
        .get('/phones', async ({ set }) => {
            if (!sql) { 
                console.error("Phones GET - DB not connected");
                set.status = 500; 
                return { error: "Database not connected" }; 
            }
            try {
                const phones = await sql`
                    SELECT phones.*, types.name as type_name 
                    FROM phones 
                    LEFT JOIN types ON phones.type_id = types.id 
                    ORDER BY phones.id DESC
                `;
                return [...phones];
            } catch (error: any) { 
                console.error("Phones GET error:", error);
                set.status = 500;
                return { error: error.message }; 
            }
        })

        // ROUTE 2: Get All Types
        .get('/types', async ({ set }) => {
            if (!sql) {
                console.error("Types GET - DB not connected");
                set.status = 500;
                return [];
            }
            try {
                const types = await sql`SELECT * FROM types ORDER BY name ASC`;
                return [...types]; 
            } catch (error: any) { 
                console.error("Types GET error:", error);
                set.status = 500;
                return []; 
            }
        })

        .post('/types', async ({ body, headers, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB Error" };
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401; 
                return { success: false };
            }
            try {
                await sql`INSERT INTO types (name) VALUES (${(body as any).name})`;
                return { success: true };
            } catch (e: any) { 
                console.error("Type creation error:", e);
                return { success: false, message: e.message }; 
            }
        }, { body: t.Object({ name: t.String() }) })

        .post('/phones', async ({ body, headers, set }) => {
            if (!sql) { 
                set.status = 500; 
                return { success: false, message: "DB Error" }; 
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return { success: false }; 
            }
            
            const b = body as any;
            try {
                await sql`
                    INSERT INTO phones (model, rrp, type_id, base_price, lcd_amt, aeon_rate, stamping_rate) 
                    VALUES (
                        ${b.model}, 
                        ${b.rrp}, 
                        ${b.type_id},
                        ${b.base_price || 0}, 
                        ${b.lcd_amt || 0}, 
                        ${b.aeon_rate || 0}, 
                        ${b.stamping_rate || 0}
                    )
                `;
                return { success: true };
            } catch (e: any) { 
                console.error("Phone creation error:", e);
                return { success: false, message: e.message }; 
            }
        })    
        
        .put('/phones/:id', async ({ params, body, headers, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB Error" };
            }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return { success: false }; 
            }
            
            const b = body as any;
            try {
                await sql`
                    UPDATE phones 
                    SET 
                        model = ${b.model}, 
                        rrp = ${b.rrp}, 
                        type_id = ${b.type_id},
                        base_price = ${b.base_price || 0},
                        lcd_amt = ${b.lcd_amt || 0},
                        aeon_rate = ${b.aeon_rate || 0},
                        stamping_rate = ${b.stamping_rate || 0}
                    WHERE id = ${params.id}
                `;
                return { success: true };
            } catch (e: any) { 
                console.error("Phone update error:", e);
                return { success: false, message: e.message }; 
            }
        })

        .delete('/phones/:id', async ({ params, headers, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false, message: "DB not connected" };
            }

            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401; 
                return { success: false, message: "Wrong Password" };
            }

            try {
                await sql`DELETE FROM phones WHERE id = ${params.id}`;
                return { success: true };
            } catch (error: any) {
                console.error("Phone deletion error:", error);
                set.status = 500;
                return { success: false, message: error.message };
            }
        })
        
        .post('/submit-application', async ({ body, set }: { body: any; set: any }) => {
            try {
                const emailBody = `
                    BORANG PERMOHONAN ANSURAN BARU
                    ===============================
                    NAMA : ${body.nama}
                    KAD PENGENALAN : ${body.ic}
                    ALAMAT : ${body.alamat}
                    TAHUN TINGGAL: ${body.tahun_tinggal}
                    RUMAH : ${body.jenis_rumah}
                    STATUS : ${body.status}
                    ANAK : ${body.anak}
                    HP : ${body.hp}
                    EMEL : ${body.email_user}
                    TARIKH GAJI : ${body.tarikh_gaji}

                    BUTIRAN KERJA
                    NAMA SYARIKAT : ${body.syarikat}
                    ALAMAT : ${body.alamat_kerja}
                    TAHUN BEKERJA: ${body.tahun_kerja}
                    NO PEJABAT : ${body.no_pejabat}
                    JAWATAN : ${body.jawatan}

                    RUJUKAN 1
                    NAMA : ${body.ref1_nama}
                    HUBUNGAN : ${body.ref1_hub}
                    HP : ${body.ref1_hp}

                    RUJUKAN 2
                    NAMA : ${body.ref2_nama}
                    HUBUNGAN : ${body.ref2_hub}
                    HP : ${body.ref2_hp}

                    BUTIRAN BANK
                    BANK : ${body.bank_nama}
                    AKAUN : ${body.bank_acc}
                `;

                const mailOptions = {
                    from: process.env.SMTP_USER,
                    to: process.env.GMAIL_BOSS,
                    replyTo: body.email_user,
                    subject: `PERMOHONAN BARU - ${body.nama}`,
                    text: emailBody,
                    attachments: [
                        { filename: `IC_${body.nama}.png`, content: Buffer.from(await body.icFile.arrayBuffer()) },
                        { filename: `SlipGaji_${body.nama}.png`, content: Buffer.from(await body.salarySlip.arrayBuffer()) }
                    ]
                };

                await transporter.sendMail(mailOptions);
                return { success: true };
            } catch (e: any) {
                console.error("Email submission error:", e);
                set.status = 500;
                return { success: false, message: e.message };
            }
        }, {
            body: t.Object({
                nama: t.String(),
                ic: t.String(),
                alamat: t.String(),
                tahun_tinggal: t.String(),
                jenis_rumah: t.String(),
                status: t.String(),
                anak: t.String(),
                hp: t.String(),
                email_user: t.String(),
                tarikh_gaji: t.String(),
                syarikat: t.String(),
                alamat_kerja: t.String(),
                tahun_kerja: t.String(),
                no_pejabat: t.String(),
                jawatan: t.String(),
                ref1_nama: t.String(),
                ref1_alamat: t.String(),
                ref1_hub: t.String(),
                ref1_hp: t.String(),
                ref2_nama: t.String(),
                ref2_alamat: t.String(),
                ref2_hub: t.String(),
                ref2_hp: t.String(),
                bank_nama: t.String(),
                bank_acc: t.String(),
                icFile: t.File(),
                salarySlip: t.File()
            })
        })
    )
    .listen(3000);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

export default app;
