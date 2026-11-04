from copy import deepcopy
import unittest
from estimator.summary_quantities import mark_incomplete_quantities
from estimator.calculator_report import _ScheduleReport
from estimator.report import _register_fonts


def example(identity='steel_vermiculite', *, pack=18):
    column='B' if identity in {'steel_vermiculite','steel_intumescent'} else 'C'
    title={'steel_vermiculite':'Product order totals','steel_intumescent':'Product orders',
           'steel_board':'Board stock totals by product and thickness','ductwork':'Product totals'}[identity]
    values={'A':'Example product','C':12,'D':0.3,'E':5.54,'F':0.1,'G':'INCOMPLETE','H':'','I':'INCOMPLETE - review schedule'}
    return {'id':identity,'rows':[{'complete':True,'values':{column:'Example product'}},
                                 {'complete':False,'values':{column:'Example product'}}],
            'summaries':[{'title':title,'sheet':'BAGS','columns':list('ACDG'),'labels':{k:k for k in 'ACDG'},'note':'',
                          'rows':[{'row':20,'values':values,'quantity_pack_litres':pack}]}],
            'extra_rows':[],'incomplete_rows':1,'quantity_notices':[]}


class PartialSummaryQuantityTests(unittest.TestCase):
    def test_spray_retains_raw_order_and_shows_known_pooled_whole_bags(self):
        _register_fonts()
        data=example(); original=deepcopy(data); report=_ScheduleReport(data)
        item=report.data['summaries'][0]['rows'][0]
        self.assertEqual(item['available_quantities'],{'G':7})
        self.assertEqual(item['values']['G'],'INCOMPLETE')
        self.assertEqual(data,original)
        report.product_totals()
        cells=[cell for flowable in report.story if hasattr(flowable,'_cellvalues') for row in flowable._cellvalues for cell in row]
        self.assertTrue(any('7.00 <font size="5.5">INCOMPLETE</font>' in getattr(cell,'text','') for cell in cells))

    def test_intumescent_partial_packs_and_litres_use_known_settings(self):
        data=example('steel_intumescent');mark_incomplete_quantities(data)
        self.assertEqual(data['summaries'][0]['rows'][0]['available_quantities'],{'G':7,'H':126})

    def test_missing_pack_settings_or_no_quantified_items_never_create_orders(self):
        for data in [example('steel_intumescent',pack=''),example()]:
            if data['id']=='steel_vermiculite':data['rows'][0]['complete']=False
            mark_incomplete_quantities(data)
            self.assertEqual(data['summaries'][0]['rows'][0]['available_quantities'],{})

    def test_all_product_summary_families_mark_only_affected_products(self):
        for identity in ('steel_vermiculite','steel_intumescent','steel_board','ductwork'):
            with self.subTest(identity=identity):
                data=example(identity)
                other=deepcopy(data['summaries'][0]['rows'][0]);other['values'].update(A='Other product',G=40,I='READY')
                data['summaries'][0]['rows'].append(other);mark_incomplete_quantities(data)
                self.assertTrue(data['summaries'][0]['rows'][0]['quantity_incomplete'])
                self.assertFalse(other['quantity_incomplete']);self.assertEqual(other['values']['G'],40)

    def test_unknown_product_marks_available_totals_incomplete_without_assigning_it(self):
        data=example();data['rows'][1]['values']['B']='';mark_incomplete_quantities(data)
        self.assertTrue(data['summaries'][0]['rows'][0]['quantity_incomplete'])


if __name__=='__main__':unittest.main()
