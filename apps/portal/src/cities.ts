// Common Indian cities and towns with their GST state code, for the City suggestions on customer forms.
// Suggestions only: any other town can still be typed.
const BY_STATE: Record<string, string> = {
  "01": "Srinagar,Jammu,Anantnag,Baramulla,Udhampur,Kathua",
  "02": "Shimla,Solan,Dharamshala,Mandi,Manali,Kullu,Baddi,Palampur",
  "03": "Ludhiana,Amritsar,Jalandhar,Patiala,Bathinda,Mohali,Pathankot,Hoshiarpur,Moga,Batala,Abohar,Phagwara,Kapurthala,Firozpur",
  "04": "Chandigarh",
  "05": "Dehradun,Haridwar,Roorkee,Haldwani,Rudrapur,Rishikesh,Kashipur,Nainital,Mussoorie",
  "06": "Gurugram,Faridabad,Panipat,Ambala,Hisar,Rohtak,Karnal,Sonipat,Yamunanagar,Panchkula,Bhiwani,Sirsa,Bahadurgarh,Jind,Kurukshetra,Rewari",
  "07": "Delhi,New Delhi",
  "08": "Jaipur,Jodhpur,Udaipur,Kota,Bikaner,Ajmer,Bhilwara,Alwar,Sikar,Pali,Sri Ganganagar,Bharatpur,Chittorgarh,Mount Abu,Jaisalmer,Tonk,Beawar",
  "09": "Lucknow,Kanpur,Ghaziabad,Noida,Greater Noida,Agra,Varanasi,Meerut,Prayagraj,Bareilly,Aligarh,Moradabad,Saharanpur,Gorakhpur,Firozabad,Jhansi,Muzaffarnagar,Mathura,Ayodhya,Rampur,Shahjahanpur,Farrukhabad,Mirzapur,Hapur,Etawah,Sultanpur,Bulandshahr,Raebareli,Unnao,Jaunpur,Azamgarh,Lakhimpur,Hardoi,Basti,Sitapur",
  "10": "Patna,Gaya,Bhagalpur,Muzaffarpur,Purnia,Darbhanga,Arrah,Begusarai,Katihar,Munger,Chhapra,Bihar Sharif,Samastipur,Hajipur,Sasaram,Dehri,Siwan,Motihari,Nawada,Bettiah,Buxar",
  "11": "Gangtok,Namchi,Mangan",
  "12": "Itanagar,Naharlagun,Pasighat,Tawang",
  "13": "Kohima,Dimapur,Mokokchung,Tuensang",
  "14": "Imphal,Thoubal,Bishnupur",
  "15": "Aizawl,Lunglei,Champhai",
  "16": "Agartala,Dharmanagar,Kailashahar",
  "17": "Shillong,Tura,Jowai",
  "18": "Guwahati,Silchar,Dibrugarh,Jorhat,Nagaon,Tinsukia,Tezpur,Bongaigaon,Dhubri,Diphu,North Lakhimpur,Goalpara",
  "19": "Kolkata,Howrah,Durgapur,Asansol,Siliguri,Bardhaman,Malda,Baharampur,Habra,Kharagpur,Shantipur,Dankuni,Dhulian,Ranaghat,Haldia,Raiganj,Krishnanagar,Nabadwip,Medinipur,Jalpaiguri,Balurghat,Basirhat,Bankura,Darjeeling,Cooch Behar,Barasat,Salt Lake",
  "20": "Ranchi,Jamshedpur,Dhanbad,Bokaro Steel City,Deoghar,Phusro,Hazaribagh,Giridih,Ramgarh,Medininagar,Chirkunda",
  "21": "Bhubaneswar,Cuttack,Rourkela,Berhampur,Sambalpur,Puri,Balasore,Bhadrak,Baripada,Jharsuguda,Jeypore,Angul,Dhenkanal,Paradip",
  "22": "Raipur,Bhilai,Bilaspur,Korba,Durg,Rajnandgaon,Raigarh,Jagdalpur,Ambikapur",
  "23": "Indore,Bhopal,Jabalpur,Gwalior,Ujjain,Sagar,Dewas,Satna,Ratlam,Rewa,Murwara,Singrauli,Burhanpur,Khandwa,Morena,Bhind,Chhindwara,Guna,Shivpuri,Vidisha,Damoh,Mandsaur,Neemuch,Hoshangabad,Itarsi,Khargone",
  "24": "Ahmedabad,Surat,Vadodara,Rajkot,Bhavnagar,Jamnagar,Junagadh,Gandhinagar,Gandhidham,Anand,Navsari,Morbi,Nadiad,Surendranagar,Bharuch,Mehsana,Bhuj,Porbandar,Palanpur,Valsad,Vapi,Godhra,Patan,Veraval,Botad,Amreli,Deesa,Ankleshwar,Kalol,Dahod,Himatnagar,Mundra",
  "26": "Daman,Diu,Silvassa",
  "27": "Mumbai,Pune,Nagpur,Thane,Nashik,Pimpri-Chinchwad,Aurangabad,Chhatrapati Sambhajinagar,Solapur,Kalyan,Dombivli,Vasai-Virar,Navi Mumbai,Bhiwandi,Amravati,Nanded,Kolhapur,Sangli,Malegaon,Jalgaon,Akola,Latur,Dhule,Ahmednagar,Chandrapur,Parbhani,Ichalkaranji,Jalna,Ambarnath,Bhusawal,Panvel,Badlapur,Beed,Gondia,Satara,Barshi,Yavatmal,Achalpur,Osmanabad,Nandurbar,Wardha,Udgir,Hinganghat,Lonavala,Ratnagiri,Alibag,Shirdi,Ulhasnagar,Mira-Bhayandar,Mahabaleshwar,Karad,Baramati,Sangamner",
  "29": "Bengaluru,Mysuru,Hubballi,Dharwad,Mangaluru,Belagavi,Kalaburagi,Davanagere,Ballari,Vijayapura,Shivamogga,Tumakuru,Raichur,Bidar,Hospet,Hassan,Gadag,Udupi,Chitradurga,Kolar,Mandya,Chikkamagaluru,Karwar,Bagalkot,Ranebennur,Chikkaballapur,Madikeri,Yelahanka,Whitefield,Electronic City",
  "30": "Panaji,Margao,Vasco da Gama,Mapusa,Ponda,Calangute,Candolim,Anjuna",
  "31": "Kavaratti",
  "32": "Thiruvananthapuram,Kochi,Kozhikode,Thrissur,Kollam,Kannur,Alappuzha,Palakkad,Malappuram,Kottayam,Kasaragod,Pathanamthitta,Munnar,Guruvayur,Thalassery,Kayamkulam,Perinthalmanna,Ernakulam,Tirur,Vatakara,Changanassery,Muvattupuzha",
  "33": "Chennai,Coimbatore,Madurai,Tiruchirappalli,Salem,Tirunelveli,Tiruppur,Erode,Vellore,Thoothukudi,Dindigul,Thanjavur,Ranipet,Sivakasi,Karur,Udhagamandalam,Hosur,Nagercoil,Kanchipuram,Kumbakonam,Rajapalayam,Pudukkottai,Ambur,Nagapattinam,Cuddalore,Tiruvannamalai,Pollachi,Namakkal,Krishnagiri,Virudhunagar,Karaikudi,Neyveli,Ooty,Kodaikanal,Avadi,Tambaram,Chengalpattu,Ramanathapuram",
  "34": "Puducherry,Karaikal,Yanam,Mahe",
  "35": "Port Blair",
  "36": "Hyderabad,Secunderabad,Warangal,Nizamabad,Karimnagar,Khammam,Ramagundam,Mahabubnagar,Nalgonda,Adilabad,Siddipet,Suryapet,Miryalaguda,Jagtial,Mancherial,Kothagudem,Sangareddy,Medchal,Kukatpally,Gachibowli",
  "37": "Visakhapatnam,Vijayawada,Guntur,Nellore,Kurnool,Rajamahendravaram,Kakinada,Tirupati,Kadapa,Anantapur,Vizianagaram,Eluru,Ongole,Nandyal,Machilipatnam,Adoni,Tenali,Proddatur,Chittoor,Hindupur,Bhimavaram,Madanapalle,Guntakal,Srikakulam,Dharmavaram,Gudivada,Narasaraopet,Tadipatri,Tadepalligudem,Amaravati,Chilakaluripet,Puttaparthi",
  "38": "Leh,Kargil",
};

export interface City { name: string; stateCode: string }

export const CITIES: City[] = Object.entries(BY_STATE)
  .flatMap(([stateCode, names]) => names.split(",").map((name) => ({ name, stateCode })))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The listed city a typed name matches exactly (ignoring case), if any. A name used in two states returns nothing: the state stays the user's call. */
export function cityNamed(text: string): City | null {
  const wanted = text.trim().toLowerCase();
  const found = CITIES.filter((c) => c.name.toLowerCase() === wanted);
  return found.length === 1 ? found[0]! : null;
}
