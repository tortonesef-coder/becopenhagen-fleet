const { getDb } = require('./schema');
const db = getDb();

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

// Clear existing data
db.exec(`
  DELETE FROM batteries; DELETE FROM bike_configurations;
  DELETE FROM bike_status; DELETE FROM bikes;
  DELETE FROM bike_types; DELETE FROM team_members;
`);

// Bike types
const types = [
  ['A',  'Adult bike',           'City Bike - Regular',     80, 5, 1],
  ['SA', 'Small adult bike',     'City Bike - Small',       80, 4, 2],
  ['AC', 'Adult + child seat',   'Child Seat',              80, 3, 3],
  ['AT', 'Adult + toddler seat', 'Toddler Seat',            80, 3, 4],
  ['B',  'Kids bike (small)',    'Child Bike',              80, 3, 5],
  ['BM', 'Kids bike (medium)',   'Child Bike',              80, 3, 6],
  ['TB', 'Touring bike',         'Touring Bike',           120, 4, 7],
  ['MB', 'Mountain bike',        'Mountain Bike',           80, 3, 8],
  ['CC', 'Cargo bike',           'Christiania Cargo Bike', 480, 4, 9],
  ['E',  'Electric bike',        'Electric Bike',          240, 4, 10],
];
const insertType = db.prepare(`INSERT OR REPLACE INTO bike_types VALUES (?,?,?,?,?,?)`);
types.forEach(t => insertType.run(...t));

// Team
const team = [
  ['fede','Fede','admin'],['hassan','Hassan','admin'],
  ['zac','Zac','mechanic'],['pam','Pam','guide'],
  ['feidhlim','Féidhlim','guide'],['ibrahim','Ibrahim','guide'],
  ['monica','Monica','guide'],['andrew','Andrew','guide'],
];
const insertTeam = db.prepare(`INSERT OR REPLACE INTO team_members (id,name,role,active) VALUES (?,?,?,1)`);
team.forEach(m => insertTeam.run(...m));

// Bikes [id, type_id, name, frame_number, model, frame_size, key_number, gender, notes]
const bikes = [
  // Adult
  ['A1','A','Agnes Obel','WAV00624U','Shopping WA1','56','3793',null,null],
  ['A2','A','Anders Holch Povlsen','WAV11147M','Winter Cargo L','52','9443',null,null],
  ['A3','A','Anja Andersen','WAV20118U','Winther 1','50','1600',null,null],
  ['A4','A','Arne Jacobsen','WAV10125M','Winter Cargo L','56','2901',null,'Painted'],
  ['A5','A','Asta Nielsen','WAV10135M','Winter Cargo L','56','YW1B',null,null],
  ['A6','A','Bertel Thorvaldsen','WAV11111M','Winter Cargo G','56','9178',null,null],
  ['A8','A','Bjarke Ingels','WAV37682N','Winther','48','4424V',null,'Last key'],
  ['A10','A','Bodil Kjer','WAV20130U','Winther 1','50','2318',null,null],
  ['A14','A','Carl Frederik Tietgen','WAV22125U','Winther 4','50','6748',null,null],
  ['A15','A','Carl Nielsen','WAV21572U','Winther 1','50','1252',null,null],
  ['A16','A','Carl Theodor Dreyer','WAV22549U','Winther 4','54','7788',null,null],
  ['A17','A','Caroline Wozniacki','WAV22630U','Winther 4','54','5783',null,null],
  ['A18','A','Christian Eriksen','WAV2040B','Winther 2','50','8737',null,null],
  ['A19','A','Christian Frederik Hansen','WAV11144M','Winther Cargo L','52','8224',null,'Key missing'],
  ['A20','A','Christian Tafdrup','WAV21565U','Winther 1','50','2316',null,null],
  ['A21','A','Claus Meyer','WAV20181U','Winther 1','50','1563',null,null],
  ['A22','A','Knud den Store','WAV21630U','Winther 1','50','1273',null,null],
  ['A24','A','Dan Stubbergaard','WAV21559U','Winther 1','50','6137',null,null],
  ['A25','A','Dirch Passer','WAV22363U','Winther 4','50','2300',null,null],
  ['A26','A','Ditte Hansen','WAV20280U','Winther 1','50','1225',null,null],
  ['A27','A','Dorte Mandrup','WAV20108U','Winther 1','50','4111V',null,null],
  ['A28','A','Erik Møller','WAV00104U','Winther Shopping Alu','48','5601',null,null],
  ['A29','A','Finn Juhl','WAV11142M','Cargo','52','2341V',null,null],
  ['A30','A','Jan Gehl','WAV00646U','Shopping Champagne','56','1551',null,null],
  ['A31','A','Poul Henningsen','WAV22429U','Black Winther 4','50','7824',null,null],
  ['A33','A','Tycho Brahe','WAV20403P','Winther Black','50','2363',null,null],
  ['A34','A','Ole Kirk Christiansen','WAV21484T','Black Winther 4','54','3333',null,null],
  ['A35','A','Viggo Mortensen','WAV20203U','Black Winther 1','50','2569V',null,null],
  ['A36','A','Tom Kristensen','WAV22031U','Black Winther 4','50','2280',null,null],
  ['A37','A','Verner Panton',null,'Green Winther','48','4745V',null,null],
  // Small adult
  ['SA1','SA','Frederik X','WAV62891T','Granny','24','4521',null,null],
  ['SA2','SA','Ghita Nørby','WAV62875T','Granny','24','9240',null,null],
  ['SA3','SA','Hans Christian Andersen','WAV62921T','Granny','24','4513',null,null],
  ['SA4','SA','Hans Christian Ørsted','WAV62959T','Granny','26','5103',null,null],
  ['SA5','SA','Hans Dissing','WAV62886T','Granny','24','5102',null,null],
  ['SA6','SA','Ove Sprogøe','WAV63017T','Granny','24','8752',null,null],
  ['SA7','SA','Vitus Bering',null,'Granny','24','9467',null,null],
  // Mountain
  ['M3','MB','Harald Bluetooth','WMB70723U','Mud XP Girl Sus 7',null,'5796',null,null],
  ['M4','MB','Henning Larsen','WMB70751U','Mud XP Girl Sus 7',null,'3868',null,null],
  ['M5','MB','Iben Hjejle','WMB70753U','Mud XP Girl Sus 7',null,'5062',null,null],
  ['M6','MB','Jacob A. Riis','WMB70748U','Mud XP Girl Sus 7',null,'1903',null,null],
  ['M7','MB','Helena Christensen','WMB70534B','Mud XB',null,'2308X',null,null],
  // Kids small
  ['B1','B','Kesi','WAV60494N','Winther R/1 Pink',null,'3962',null,null],
  ['B2','B','Mew','WAV61106N','Winther R/1 Black',null,'2655',null,null],
  ['B3','B','Per Fly','WAV61094N','Winther R/1',null,'3135V',null,null],
  ['B5','B','MØ','WHJ90626N','Principia Evoke A2.4',null,null,null,null],
  // Kids medium
  ['BM1','BM','Thomas Vinterberg','WAV61882M','Winther R/1',null,'2390X',null,null],
  ['BM2','BM','Karen Blixen','WAV61946M','Winther R/1 Yellow',null,'2375X',null,null],
  ['BM4','BM','Kim Bodnia','WAV60646M','Winther R/1 Pink',null,'7966',null,null],
  // Adult + child seat
  ['AC1','AC','Jesper Christensen','WAV22374U','Winther 4','50','5769',null,null],
  ['AC2','AC','Jonas Vingegaard','WAV22068U','Black Winther 4','50','5740',null,null],
  ['AC3','AC','King Diamond','WAV20426B','Black Winther 2','50','8284',null,null],
  ['AC4','AC','Jussi Adler-Olsen','WAV04006T','Winther Shopper','50','4595',null,null],
  ['AC5','AC','René Redzepi','WAV30831N','Shopping Alu','48','1302V',null,null],
  // Adult + toddler seat
  ['AT1','AT','Johan Sundstein','WAV20163J','Black Winther 1','50','3878V',null,null],
  ['AT2','AT','Jørn Utzon','WAV0101232M','Black Winther Cargo','56','3475',null,'Spray painted'],
  ['AT3','AT','Kasper Schmeichel','WAV20268U','Winther 1','50','2312V',null,null],
  ['AT4','AT','Kaare Klint','WAV22289T','Winther 1','54','4236V',null,null],
  ['AT5','AT','Lars von Trier','WAV11149M','Black Winther Cargo','52','8032',null,'Consider renumbering'],
  // Touring
  ['TB1','TB','Margrethe II','WMB30289T','Octane Cross GN 700','19"',null,'lady',null],
  ['TB3','TB','Niels Bohr','WMB32732T','Octane Cross GN 700','17"',null,'lady',null],
  ['TB4','TB','Lars Ulrich','WMB32629T','Octane Cross GN 700','17"',null,'men',null],
  ['TB5','TB','Piet Hein','WMB30297T','Octane Cross GN 700','19"','M306 027','lady',null],
  ['TB6','TB','Lene Tranberg','WMB32659T','Octane Cross GN 700','17"','M305 454','men',null],
  ['TB7','TB','Lise Nørgaard','WMB30323T','Octane Cross GN 700','19"',null,'lady',null],
  ['TB8','TB','Peter Høeg','WMB32670T','Octane Cross GN 700','19"',null,'men',null],
  ['TB9','TB','Lukas Forchhammer','WMB32632T','Octane Cross GN 700','17"','M306 144','men',null],
  ['TB10','TB','Lars Christensen','WMB32747T','Octane Cross GN 700','17"','M306 041','lady',null],
  ['TB11','TB','Peter Glob','WMB32621T','MBK Octane Cross','17"',null,'men',null],
  ['TB12','TB','Niels-Henning Ørsted Pedersen','WMB32643T','MBK Octane Cross','17"',null,'men',null],
  ['TB13','TB','Peter Schmeichel','WMB32653T','MBK Octane Cross','17"',null,'men',null],
  ['TB14','TB','Pilou Asbæk','WMB32636T','MBK Octane Cross','17"',null,'men',null],
  ['TB15','TB','Princess Benedikte','WMB30134T','MBK Octane Cross','19"',null,'men',null],
  ['TB16','TB','Princess Marie','WMB30160T','MBK Octane Cross','19"',null,'men',null],
  ['TB17','TB','Queen Ingrid','WMB32673T','MBK Octane Cross','19"',null,'men',null],
  ['TB18','TB','Rasmus Seebach','WMB32674T','MBK Octane Cross','19"',null,'men',null],
  // Cargo
  ['CC1','CC','Mads Mikkelsen',null,'Christiania Classic',null,null,null,null],
  ['CC2','CC','Ole Rømer','CS22036N','Christiania Classic',null,'9521',null,'Lock loose'],
  ['CC3','CC','Michael Laudrup','CS15574L','Christiania Classic',null,'3866',null,'Chain guard'],
  ['CC4','CC','Mikkel Hansen',null,'Christiania Classic',null,null,null,null],
  ['CC5','CC','N.F.S. Grundtvig',null,'Christiania Classic',null,null,null,null],
  // Electric
  ['E2','E','Nicolas Steno','WAV54506P','Winther Superb 1','52','5547',null,null],
  ['E3','E','Niels Arden Oplev',null,'Winther Superb 1','52',null,null,null],
  ['E4','E','Mads Pedersen',null,'Winther Superb 1','52',null,null,'Painted'],
  ['E5','E','Niels G. Thomsen','WAV57447S','Winther Superb 1','52','2362',null,'Painted, shift cable changed'],
  ['E6','E','Niels Peter Louis-Hansen','WAV67085T','Winther Superb 1','52','5809',null,null],
  ['E7','E','Laila Ro','WAV56843T','Winther Superb 1','52','1930',null,'Front brakes issue'],
  ['E8','E','Nikolaj Coster-Waldau','WN372719T','Raleigh Sussex E1','48',null,null,null],
  ['E9','E','Mikkel Kessler','WN373182T','Raleigh Sussex E1','48',null,null,null],
  ['E10','E','Otto Weitling','WN372842T','Raleigh Sussex E1','48',null,null,null],
  ['E11','E','Paprika Steen','WN372685T','Raleigh Sussex E1','48',null,null,null],
];

const insertBike = db.prepare(`INSERT OR REPLACE INTO bikes (id,type_id,name,frame_number,model,frame_size,key_number,gender,notes,active) VALUES (?,?,?,?,?,?,?,?,?,1)`);
const insertStatus = db.prepare(`INSERT OR REPLACE INTO bike_status (bike_id,status,updated_by) VALUES (?,'available','system')`);
const insertConfig = db.prepare(`INSERT OR REPLACE INTO bike_configurations (bike_id,has_child_seat,has_toddler_seat) VALUES (?,?,?)`);

bikes.forEach(b => {
  insertBike.run(...b);
  insertStatus.run(b[0]);
  insertConfig.run(b[0], b[1]==='AC'?1:0, b[1]==='AT'?1:0);
});

// Batteries [id, serial, type, range_km, key_number, paired_bike_id, notes]
const batteries = [
  ['BAT2','DKGD16EHC3018','new',77,'4787V','E2',null],
  ['BAT3','DKGD12EHC3022','new',77,'4701V','E3',null],
  ['BAT4','DKAE203KBB2063','old',35,null,'E4','Lock needs changing'],
  ['BAT6','X22H110BW0092','old',32,null,'E6','Lock needs changing'],
  ['BAT7','DKD420KBB2075','old',36,null,'E7','Lock needs changing'],
  ['BAT8','DKE118KBA8021','old',40,null,'E8','Lock needs changing'],
  ['BAT9','DKD406KBB2315','old',37,null,'E9','Lock needs changing'],
  ['BAT10','DKH825KHD2023','new',80,'1036V','E10',null],
  ['BAT11',null,'new',80,null,'E11',null],
  ['BAT12',null,'new',80,null,null,null],
  ['BAT13',null,'new',80,null,null,null],
];

const insertBat = db.prepare(`INSERT OR REPLACE INTO batteries (id,serial,type,range_km,key_number,paired_bike_id,status,notes,active) VALUES (?,?,?,?,?,?,'available',?,1)`);
batteries.forEach(b => insertBat.run(...b));

console.log(`Seeded: ${types.length} types, ${team.length} team, ${bikes.length} bikes, ${batteries.length} batteries`);
