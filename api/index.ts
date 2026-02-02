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
            prepare: false // FIX: Supabase transaction poolers often need this
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
        .get('/phones', async () => {
            if (!sql) return { error: "DB Error" };
            try {
                // Join tables so we get the type name (e.g., "TV") along with the phone
                const phones = await sql`
                    SELECT phones.*, types.name as type_name 
                    FROM phones 
                    LEFT JOIN types ON phones.type_id = types.id 
                    ORDER BY phones.id DESC
                `;
                return [...phones];
            } catch (error: any) { return { error: error.message }; }
        })

        // NEW: Get All Types (for the dropdowns)
        .get('/types', async () => {
            if (!sql) return [];
            return await sql`SELECT * FROM types ORDER BY name ASC`;
        })

        // NEW: Add New Type (Protected)
        .post('/types', async ({ body, headers, set }) => {
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401; return { success: false };
            }
            try {
                await sql`INSERT INTO types (name) VALUES (${(body as any).name})`;
                return { success: true };
            } catch (e: any) { return { success: false, message: e.message }; }
        }, { body: t.Object({ name: t.String() }) })

        // MODIFIED: Add Phone (Now requires type_id)
        .post('/phones', async ({ body, headers, set }) => {
            const b = body as any;
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401; return { success: false };
            }
            try {
                await sql`
                    INSERT INTO phones (model, rrp, type_id) 
                    VALUES (${b.model}, ${b.rrp}, ${b.type_id})
                `;
                return { success: true };
            } catch (e: any) { return { success: false, message: e.message }; }
        }, { 
        })

        .post('/phones', async ({ body, headers, set }) => {
            if (!sql) {
                set.status = 500;
                return { success: false, message: "Database not connected (Check Vercel Logs)" };
            }

            try {
                const adminPass = headers['admin-secret'];
                if (adminPass !== process.env.ADMIN_PASSWORD) {
                    set.status = 401; 
                    return { success: false, message: "Wrong Admin Password" };
                }

                await sql`
                    INSERT INTO phones (model, rrp) 
                    VALUES (${(body as any).model}, ${(body as any).rrp})
                `;
                return { success: true };
            } catch (error: any) {
                console.error("Insert Error:", error);
                set.status = 500; // FIX: Tell frontend this failed
                return { success: false, message: "DB Error: " + error.message };
            }
        }, {
            body: t.Object({ model: t.String(), rrp: t.Number() })
        })
        
        .put('/phones/:id', async ({ params, body, headers, set }) => {
            if (!sql) return { success: false, message: "DB not connected" };
            
            // Check Admin Password
            if (headers['admin-secret'] !== process.env.ADMIN_PASSWORD) {
                set.status = 401; 
                return { success: false, message: "Wrong Password" };
            }

            try {
                // Update specific phone by ID
                await sql`
                    UPDATE phones 
                    SET model = ${(body as any).model}, rrp = ${(body as any).rrp}
                    WHERE id = ${params.id}
                `;
                return { success: true };
            } catch (error: any) {
                return { success: false, message: error.message };
            }
        }, {
            body: t.Object({ model: t.String(), rrp: t.Number() })
        })

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
