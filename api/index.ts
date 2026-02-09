import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import nodemailer from 'nodemailer';
import postgres from 'postgres';

let sql: any;
try {
    if (!process.env.DATABASE_URL) {
        console.error("❌ ERROR: DATABASE_URL is missing!");
    } else {
        // Connect to Supabase
        sql = postgres(process.env.DATABASE_URL, { 
            ssl: 'require', 
            prepare: false 
        });
    }
} catch (err) {
    console.error("❌ Database Connection Failed:", err);
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

const app = new Elysia()
    .use(cors())
    .group('/api', app => app

        .post('/audits', async ({ body, set }) => {
            if (!sql) { set.status = 500; return { success: false, message: "DB Error" }; }
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
            } catch (e: any) { return { success: false, message: e.message }; }
        })

        // 2. Get Audits (Admin Only)
        .get('/audits', async ({ headers, set }) => {
            if (!sql) return [];
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { set.status = 401; return []; }
            try {
                // Get latest 50 audits
                const audits = await sql`SELECT * FROM audits ORDER BY created_at DESC LIMIT 50`;
                return [...audits];
            } catch (e) { return []; }
        })

        .post('/login', async ({ body, set }) => {
            if (!sql) { set.status = 500; return { success: false, message: "DB Disconnected" }; }
            try {
                const users = await sql`SELECT * FROM users WHERE username = ${body.username} AND password = ${body.password}`;
                if (users.length > 0) {
                    // FIX: Included 'branch' in the response
                    return { 
                        success: true, 
                        role: users[0].role, 
                        username: users[0].username, 
                        name: users[0].name, 
                        branch: users[0].branch 
                    }; 
                }
                set.status = 401; return { success: false, message: "Invalid ID or Password" };
            } catch (e: any) { return { success: false, message: e.message }; }
        }, { body: t.Object({ username: t.String(), password: t.String() }) })

        // GET USERS (Updated to fetch name and branch)
        .get('/users', async ({ headers, set }) => {
            if (!sql) return [];
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { set.status = 401; return []; }
            try {
                const users = await sql`SELECT id, username, role, name, branch FROM users ORDER BY id ASC`;
                return [...users];
            } catch (e) { return []; }
        })

        // CREATE STAFF (Updated to accept name and branch)
        .post('/users', async ({ body, headers, set }) => {
            if (!sql) return { success: false, message: "DB Error" };
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { set.status = 401; return { success: false }; }
            try {
                const b = body as any;
                await sql`
                    INSERT INTO users (username, password, role, name, branch) 
                    VALUES (${b.username}, ${b.password}, 'staff', ${b.name}, ${b.branch})
                `;
                return { success: true };
            } catch (e: any) { return { success: false, message: e.message }; }
        })

        // 4. Delete Staff
        .delete('/users/:id', async ({ params, headers, set }) => {
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { set.status = 401; return { success: false }; }
            await sql`DELETE FROM users WHERE id = ${params.id}`;
            return { success: true };
        })

        // NEW: Update Staff Password
        .put('/users/:id', async ({ params, body, headers, set }) => {
            // Security Check
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { 
                set.status = 401; 
                return { success: false, message: "Unauthorized" }; 
            }
            
            const b = body as any;
            try {
                // Update password for the specific user ID
                await sql`UPDATE users SET password = ${b.password} WHERE id = ${params.id}`;
                return { success: true };
            } catch (e: any) { 
                return { success: false, message: e.message }; 
            }
        }, { body: t.Object({ password: t.String() }) })
        
        // ROUTE 1: Get All Phones
        .get('/phones', async () => {
            if (!sql) return { error: "DB Error" };
            try {
                const phones = await sql`
                    SELECT phones.*, types.name as type_name 
                    FROM phones 
                    LEFT JOIN types ON phones.type_id = types.id 
                    ORDER BY phones.id DESC
                `;
                // FIX: Use [...phones] to convert to plain array
                return [...phones];
            } catch (error: any) { return { error: error.message }; }
        })

        // ROUTE 2: Get All Types (The one causing your error!)
        .get('/types', async () => {
            if (!sql) return [];
            try {
                const types = await sql`SELECT * FROM types ORDER BY name ASC`;
                // FIX: This was missing the [...types] spread operator
                return [...types]; 
            } catch (error: any) { return []; }
        })

        // ROUTE 3: Add New Type
        .post('/types', async ({ body, headers, set }) => {
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401; return { success: false };
            }
            try {
                await sql`INSERT INTO types (name) VALUES (${(body as any).name})`;
                return { success: true };
            } catch (e: any) { return { success: false, message: e.message }; }
        }, { body: t.Object({ name: t.String() }) })

        // ROUTE 4: Add New Phone
        .post('/phones', async ({ body, headers, set }) => {
            if (!sql) { set.status = 500; return { success: false }; }
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { set.status = 401; return { success: false }; }
            
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
            } catch (e: any) { return { success: false, message: e.message }; }
        })    
        
        // ROUTE 5: Edit Phone
        .put('/phones/:id', async ({ params, body, headers, set }) => {
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) { set.status = 401; return { success: false }; }
            
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
            } catch (e: any) { return { success: false, message: e.message }; }
        })

        // ROUTE 6: Delete Phone
        .delete('/phones/:id', async ({ params, headers, set }) => {
            if (!sql) return { success: false, message: "DB not connected" };

            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401; 
                return { success: false, message: "Wrong Password" };
            }

            try {
                await sql`DELETE FROM phones WHERE id = ${params.id}`;
                return { success: true };
            } catch (error: any) {
                return { success: false, message: error.message };
            }
        })
        
        // ROUTE 7: Submit Email
        .post('/submit-application', async ({ body }: { body: any }) => {
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
                from: process.env.GMAIL_USER,
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
    );

export default app;
